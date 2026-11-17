import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';
import { createGatewayService } from '../src/gateway-server.js';

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
  });
}

function eventCollector() {
  const events = [];
  const emitter = new EventEmitter();
  return {
    add(event) {
      events.push(event);
      emitter.emit('event', event);
    },
    async waitFor(type, predicate = () => true) {
      const existing = events.find((event) => event.type === type && predicate(event));
      if (existing) return existing;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          emitter.off('event', onEvent);
          reject(new Error(`Timed out waiting for ${type}`));
        }, 2000);
        const onEvent = (event) => {
          if (event.type !== type || !predicate(event)) return;
          clearTimeout(timeout);
          emitter.off('event', onEvent);
          resolve(event);
        };
        emitter.on('event', onEvent);
      });
    },
  };
}

async function webClient(port, name) {
  const collector = eventCollector();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/tailchat/ws`);
  socket.on('message', (data) => collector.add(JSON.parse(data.toString('utf8'))));
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'hello', name }));
  const welcome = await collector.waitFor('welcome');
  return {
    id: welcome.self.id,
    socket,
    send: (payload) => socket.send(JSON.stringify(payload)),
    waitFor: collector.waitFor,
  };
}

async function sshBridgeClient(port, name) {
  const collector = eventCollector();
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) collector.add(JSON.parse(line));
      newline = buffer.indexOf('\n');
    }
  });
  await once(socket, 'connect');
  socket.write(`${JSON.stringify({ type: 'hello', name })}\n`);
  const welcome = await collector.waitFor('welcome');
  return {
    id: welcome.self.id,
    socket,
    send: (payload) => socket.write(`${JSON.stringify(payload)}\n`),
    waitFor: collector.waitFor,
  };
}

test('mobile page is served only from /tailchat/ with restrictive browser headers', async (context) => {
  const service = createGatewayService({ httpPort: 0, sshPort: 0 });
  const addresses = await service.listen();
  context.after(() => service.close());
  const port = addresses.http.port;

  const redirect = await request(port, '/tailchat');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/tailchat/');

  const page = await request(port, '/tailchat/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page.body, /<textarea/);
  assert.match(page.body, /Кто на линии/);
  assert.doesNotMatch(page.body, /xterm|ttyd/i);

  assert.equal((await request(port, '/chat/')).status, 404);
  assert.deepEqual(JSON.parse((await request(port, '/health')).body), { ok: true });
});

test('web and SSH bridge clients pair and exchange messages through one room', async (context) => {
  const service = createGatewayService({ httpPort: 0, sshPort: 0 });
  const addresses = await service.listen();
  context.after(() => service.close());

  const anna = await webClient(addresses.http.port, 'Анна Web');
  const boris = await sshBridgeClient(addresses.ssh.port, 'Борис SSH');
  context.after(() => {
    anna.socket.terminate();
    boris.socket.destroy();
  });

  anna.send({ type: 'peer', peer: boris.id });
  assert.equal((await anna.waitFor('paired')).peer.name, 'Борис SSH');
  assert.equal((await boris.waitFor('paired')).peer.name, 'Анна Web');

  boris.send({ type: 'message', text: 'Сообщение из терминала' });
  const incoming = await anna.waitFor('message');
  assert.equal(incoming.text, 'Сообщение из терминала');
  assert.equal(incoming.own, false);

  anna.send({ type: 'message', text: 'Ответ из браузера' });
  const reply = await boris.waitFor('message', (event) => event.text === 'Ответ из браузера');
  assert.equal(reply.own, false);
});

test('browser upgrades from another origin are rejected', async (context) => {
  const service = createGatewayService({ httpPort: 0, sshPort: 0 });
  const addresses = await service.listen();
  context.after(() => service.close());

  const socket = new WebSocket(`ws://127.0.0.1:${addresses.http.port}/tailchat/ws`, {
    origin: 'https://example.invalid',
  });
  const [error] = await once(socket, 'error');
  assert.match(error.message, /403/);
});
