#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { GatewayRoom } from './gateway-core.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_ROOT = path.resolve(MODULE_DIR, '../web/gateway');
const WEB_PREFIX = '/tailchat';
const MAX_LINE_BYTES = 16 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

export function createGatewayService({
  host = process.env.TAILCHAT_GATEWAY_HOST || '127.0.0.1',
  httpPort = numberFromEnv('TAILCHAT_GATEWAY_PORT', 7681),
  sshHost = process.env.TAILCHAT_GATEWAY_SSH_HOST || '127.0.0.1',
  sshPort = numberFromEnv('TAILCHAT_GATEWAY_SSH_PORT', 7682),
  webRoot = DEFAULT_WEB_ROOT,
  room = new GatewayRoom(),
} = {}) {
  const assets = loadAssets(webRoot);
  const httpServer = http.createServer((request, response) => {
    serveHttp(request, response, assets);
  });
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_LINE_BYTES,
    perMessageDeflate: false,
  });

  webSockets.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    const connection = room.connect((payload) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'Text messages only');
        return;
      }
      try {
        connection.receive(JSON.parse(data.toString('utf8')));
      } catch {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'error', code: 'invalid_json', message: 'Некорректный запрос.' }));
        }
      }
    });
    socket.once('close', connection.close);
    socket.once('error', connection.close);
  });

  httpServer.on('upgrade', (request, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url, 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400);
      return;
    }

    if (requestUrl.pathname !== `${WEB_PREFIX}/ws` || !sameOrigin(request)) {
      rejectUpgrade(socket, 403);
      return;
    }

    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit('connection', webSocket, request);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of webSockets.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref();
  const sshSockets = new Set();


  const sshServer = net.createServer((socket) => {
    sshSockets.add(socket);
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    const connection = room.connect((payload) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
    });
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) {
        socket.end(`${JSON.stringify({ type: 'error', code: 'request_too_large', message: 'Запрос слишком большой.' })}\n`);
        return;
      }

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            connection.receive(JSON.parse(line));
          } catch {
            socket.write(`${JSON.stringify({ type: 'error', code: 'invalid_json', message: 'Некорректный запрос.' })}\n`);
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
    socket.once('close', () => {
      sshSockets.delete(socket);
      connection.close();
    });
    socket.once('error', connection.close);
  });

  return {
    httpServer,
    sshServer,
    room,
    async listen() {
      try {
        await Promise.all([
          listen(httpServer, httpPort, host),
          listen(sshServer, sshPort, sshHost),
        ]);
      } catch (error) {
        clearInterval(heartbeat);
        await Promise.allSettled([closeServer(httpServer), closeServer(sshServer)]);
        webSockets.close();
        throw error;
      }
      return {
        http: httpServer.address(),
        ssh: sshServer.address(),
      };
    },
    async close() {
      clearInterval(heartbeat);
      for (const socket of webSockets.clients) socket.terminate();
      for (const socket of sshSockets) socket.destroy();
      await Promise.all([
        closeServer(httpServer),
        closeServer(sshServer),
      ]);
      webSockets.close();
    },
  };
}

function loadAssets(webRoot) {
  return new Map([
    [`${WEB_PREFIX}/`, readAsset(webRoot, 'index.html')],
    [`${WEB_PREFIX}/app.css`, readAsset(webRoot, 'app.css')],
    [`${WEB_PREFIX}/app.js`, readAsset(webRoot, 'app.js')],
  ]);
}

function readAsset(webRoot, filename) {
  const body = fs.readFileSync(path.join(webRoot, filename));
  return {
    body,
    contentType: CONTENT_TYPES[path.extname(filename)] || 'application/octet-stream',
  };
}

function serveHttp(request, response, assets) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/health') {
    writeResponse(response, 200, 'application/json; charset=utf-8', Buffer.from('{"ok":true}\n'));
    return;
  }
  if (request.method === 'GET' && url.pathname === WEB_PREFIX) {
    response.writeHead(308, { Location: `${WEB_PREFIX}/` });
    response.end();
    return;
  }

  const asset = request.method === 'GET' ? assets.get(url.pathname) : null;
  if (!asset) {
    writeResponse(response, 404, 'text/plain; charset=utf-8', Buffer.from('Not found\n'));
    return;
  }
  writeResponse(response, 200, asset.contentType, asset.body);
}

function writeResponse(response, status, contentType, body) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss: ws:; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  response.end(body);
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function rejectUpgrade(socket, status) {
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function numberFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : fallback;
}

