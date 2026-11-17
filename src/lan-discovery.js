import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';
import os from 'node:os';
import { verifyCertificate, verifyData } from './identity.js';

export const DEFAULT_LAN_PORT = 4748;
export const DEFAULT_BEACON_INTERVAL_MS = 2500;
export const DEFAULT_PEER_TTL_MS = 8000;

export function calculateBroadcastAddress(ip, netmask) {
  try {
    const ipParts = ip.split('.').map(Number);
    const maskParts = netmask.split('.').map(Number);
    if (ipParts.length !== 4 || maskParts.length !== 4) return null;
    const bcastParts = ipParts.map((part, i) => (part | (~maskParts[i] & 255)));
    return bcastParts.join('.');
  } catch {
    return null;
  }
}

export function getLocalBroadcastAddresses() {
  const addresses = new Set(['255.255.255.255']);
  try {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      if (!Array.isArray(list)) continue;
      for (const iface of list) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const bcast = calculateBroadcastAddress(iface.address, iface.netmask);
          if (bcast) addresses.add(bcast);
        }
      }
    }
  } catch {
    // fallback to global broadcast
  }
  return Array.from(addresses);
}

export function getLocalIpv4Addresses() {
  const ips = new Set(['127.0.0.1']);
  try {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      if (!Array.isArray(list)) continue;
      for (const iface of list) {
        if (iface.family === 'IPv4') {
          ips.add(iface.address);
        }
      }
    }
  } catch {}
  return ips;
}

export function createLanDiscovery({
  port = Number(process.env.TAILCHAT_LAN_PORT || DEFAULT_LAN_PORT),
  tcpPort = 4747,
  name = os.hostname(),
  login = '',
  identity = null,
  cert = null,
  serverVerifyKey = null,
  beaconIntervalMs = DEFAULT_BEACON_INTERVAL_MS,
  peerTtlMs = DEFAULT_PEER_TTL_MS,
  now = Date.now,
  dgramImpl = dgram,
} = {}) {
  const emitter = new EventEmitter();
  const peers = new Map(); // key: "${address}:${tcpPort}" -> peer record

  let socket = null;
  let beaconTimer = null;
  let sweepTimer = null;
  let running = false;
  let ownIps = getLocalIpv4Addresses();

  function buildBeaconPayload() {
    return JSON.stringify({
      t: 'lan-beacon',
      v: 1,
      name: String(name ?? '').trim(),
      login: String(login ?? '').trim().toLowerCase(),
      port: Number(tcpPort || 4747),
      identity: identity ? {
        pubKey: identity.pubKey,
        cert: cert || null,
      } : null,
      ts: now(),
    });
  }

  function announce() {
    if (!socket || !running) return;
    const message = Buffer.from(buildBeaconPayload(), 'utf8');
    const targets = getLocalBroadcastAddresses();

    for (const target of targets) {
      try {
        socket.send(message, 0, message.length, port, target, () => {});
      } catch {
        // ignore send errors on unavailable interfaces
      }
    }
  }

  function handleMessage(msgBuffer, rinfo) {
    if (!running) return;
    const senderIp = rinfo.address;
    let payload;
    try {
      payload = JSON.parse(msgBuffer.toString('utf8'));
    } catch {
      return;
    }

    if (!payload || payload.t !== 'lan-beacon') return;

    // Filter self-beacons
    if (identity?.pubKey && payload.identity?.pubKey === identity.pubKey) {
      return;
    }
    if (ownIps.has(senderIp) && payload.port === tcpPort && payload.name === name) {
      return;
    }

    const peerTcpPort = Number(payload.port || 4747);
    const key = `${senderIp}:${peerTcpPort}`;
    const peerLogin = String(payload.login ?? '').trim().toLowerCase();
    const peerName = String(payload.name ?? '').trim() || peerLogin || senderIp;

    let verifiedByCloud = false;
    if (payload.identity?.cert && serverVerifyKey) {
      verifiedByCloud = verifyCertificate(payload.identity.cert, serverVerifyKey, now());
    }

    const at = now();
    const existing = peers.get(key);

    const peerRecord = {
      key,
      address: senderIp,
      port: peerTcpPort,
      name: peerName,
      login: peerLogin,
      identity: payload.identity || null,
      verified: verifiedByCloud,
      lastSeen: at,
    };

    peers.set(key, peerRecord);

    if (!existing) {
      emitter.emit('peer', peerRecord);
      emitter.emit('change', Array.from(peers.values()));
    } else {
      let changed = false;
      if (existing.name !== peerName || existing.login !== peerLogin || existing.verified !== verifiedByCloud) {
        changed = true;
      }
      if (changed) {
        emitter.emit('change', Array.from(peers.values()));
      }
    }
  }

  function sweep() {
    if (!running) return;
    const at = now();
    let changed = false;

    for (const [key, peer] of peers.entries()) {
      if (at - peer.lastSeen > peerTtlMs) {
        peers.delete(key);
        changed = true;
        emitter.emit('lost', peer);
      }
    }

    if (changed) {
      emitter.emit('change', Array.from(peers.values()));
    }
  }

  return Object.assign(emitter, {
    start() {
      if (running) return Promise.resolve();
      running = true;
      ownIps = getLocalIpv4Addresses();

      return new Promise((resolve) => {
        try {
          socket = dgramImpl.createSocket({ type: 'udp4', reuseAddr: true });
        } catch {
          socket = dgramImpl.createSocket('udp4');
        }

        socket.on('error', (err) => {
          emitter.emit('error', err);
        });

        socket.on('message', (msg, rinfo) => {
          handleMessage(msg, rinfo);
        });

        socket.bind(port, '0.0.0.0', () => {
          try {
            socket.setBroadcast(true);
          } catch {}

          announce();
          beaconTimer = setInterval(announce, beaconIntervalMs);
          beaconTimer?.unref?.();

          sweepTimer = setInterval(sweep, Math.min(2000, peerTtlMs / 2));
          sweepTimer?.unref?.();

          resolve();
        });
      });
    },

    stop() {
      if (!running) return Promise.resolve();
      running = false;

      if (beaconTimer) {
        clearInterval(beaconTimer);
        beaconTimer = null;
      }
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }

      peers.clear();

      return new Promise((resolve) => {
        if (socket) {
          try {
            socket.close(() => {
              socket = null;
              resolve();
            });
          } catch {
            socket = null;
            resolve();
          }
        } else {
          resolve();
        }
      });
    },

    announceNow() {
      announce();
    },

    getPeers() {
      return Array.from(peers.values());
    },

    findPeerByLogin(loginQuery) {
      const q = String(loginQuery ?? '').trim().toLowerCase();
      if (!q) return null;
      for (const peer of peers.values()) {
        if (peer.login === q) return peer;
      }
      return null;
    },

    findPeerByAddress(ipQuery) {
      const q = String(ipQuery ?? '').trim();
      if (!q) return null;
      for (const peer of peers.values()) {
        if (peer.address === q) return peer;
      }
      return null;
    },

    isRunning() {
      return running;
    },
  });
}
