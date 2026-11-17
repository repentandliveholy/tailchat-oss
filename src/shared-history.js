import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDeviceStore } from './secure-store.js';

export const SHARED_HISTORY_LIMIT = 200;
const SEEN_LIMIT = 4096;
const QUEUE_LIMIT = 500;
const REQUEST_TIMEOUT_MS = 3500;

function validRoom(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value);
}

export function resolveSharedHistory(config = {}) {
  const raw = config.sharedHistory;
  if (!raw || typeof raw !== 'object') return null;
  if (!validRoom(raw.room)) return null;
  try {
    const url = new URL(raw.url);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.pathname = url.pathname.replace(/\/$/, '');
    return { url: url.toString().replace(/\/$/, ''), room: raw.room };
  } catch {
    return null;
  }
}

export function sharedHistoryStateFile(stateDir, room) {
  const digest = crypto.createHash('sha256').update(room).digest('hex').slice(0, 16);
  return path.join(stateDir, `shared-history-${digest}.json`);
}

function validRecord(value) {
  return value
    && typeof value === 'object'
    && typeof value.id === 'string'
    && value.id.length > 0
    && value.id.length <= 128
    && typeof value.name === 'string'
    && value.name.length > 0
    && value.name.length <= 128
    && typeof value.text === 'string'
    && Number.isFinite(value.ts)
    && (value.kind === 'human' || value.kind === 'ai');
}

function readState(file, store) {
  let raw;
  try { raw = store.read(file); }
  catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(file)) return { seen: [], pending: [] };
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); }
  catch { throw new Error(`Corrupted encrypted shared history: ${file}`); }
  if (!parsed || !Array.isArray(parsed.seen) || !Array.isArray(parsed.pending)
    || parsed.seen.some((id) => typeof id !== 'string')
    || parsed.pending.some((entry) => !validRecord(entry))) {
    throw new Error(`Invalid encrypted shared history: ${file}`);
  }
  return { seen: parsed.seen.slice(-SEEN_LIMIT), pending: parsed.pending.slice(-QUEUE_LIMIT) };
}

function writeState(file, state, store) {
  store.write(file, Buffer.from(`${JSON.stringify(state)}\n`));
  return true;
}

function inertHistory() {
  return {
    has: () => false,
    restore: async () => [],
    latestRelease: async () => null,
    record: () => false,
    flush: async () => false,
  };
}

function fetchWithTimeout(url, options, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchImpl(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export function createSharedHistory(config, stateDir, {
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  limit = SHARED_HISTORY_LIMIT,
  store = openDeviceStore(),
} = {}) {
  const settings = resolveSharedHistory(config);
  if (!settings || typeof fetchImpl !== 'function') return inertHistory();

  const file = sharedHistoryStateFile(stateDir, settings.room);
  const state = readState(file, store);
  const seen = new Set(state.seen);
  let flushing = null;

  const persist = () => writeState(file, state, store);
  const remember = (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    state.seen.push(id);
    while (state.seen.length > SEEN_LIMIT) seen.delete(state.seen.shift());
    return true;
  };

  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      let sent = false;
      while (state.pending.length > 0) {
        const message = state.pending[0];
        let response;
        try {
          response = await fetchWithTimeout(`${settings.url}/v1/history/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ room: settings.room, message }),
          }, fetchImpl, timeoutMs);
        } catch {
          break;
        }
        if (!response.ok) break;
        const delivered = state.pending.shift();
        try { persist(); }
        catch (error) {
          state.pending.unshift(delivered);
          throw error;
        }
        sent = true;
      }
      return sent;
    })();
    try {
      return await flushing;
    } finally {
      flushing = null;
    }
  }

  return {
    enabled: true,
    file,
    has(id) {
      return typeof id === 'string' && seen.has(id);
    },
    record(message) {
      if (!validRecord(message) || seen.has(message.id)) return false;
      if (state.pending.length >= QUEUE_LIMIT) throw new Error('Shared history queue is full');
      state.pending.push(message);
      try { persist(); } catch (error) { state.pending.pop(); throw error; }
      remember(message.id);
      void flush();
      return true;
    },
    async restore() {
      let response;
      try {
        const query = new URLSearchParams({ room: settings.room, limit: String(limit) });
        response = await fetchWithTimeout(`${settings.url}/v1/history/messages?${query}`, {}, fetchImpl, timeoutMs);
      } catch {
        return [];
      }
      if (!response.ok) return [];
      let body;
      try { body = await response.json(); } catch { return []; }
      if (!Array.isArray(body?.messages)) return [];
      const pendingIds = new Set(state.pending.map((message) => message.id));
      const restored = [];
      for (const message of body.messages.filter(validRecord)) {
        if (pendingIds.has(message.id)) {
          state.pending = state.pending.filter((pending) => pending.id !== message.id);
        }
        if (remember(message.id)) restored.push(message);
      }
      persist();
      void flush();
      return restored;
    },
    async latestRelease() {
      let response;
      try {
        response = await fetchWithTimeout(`${settings.url}/v1/release`, {}, fetchImpl, timeoutMs);
      } catch {
        return null;
      }
      if (!response.ok) return null;
      let manifest;
      try { manifest = await response.json(); } catch { return null; }
      if (
        !manifest
        || typeof manifest.version !== 'string'
        || manifest.version.length === 0
        || manifest.version.length > 64
        || typeof manifest.notes !== 'string'
        || manifest.notes.length > 6000
      ) return null;
      return { version: manifest.version, notes: manifest.notes };
    },
    flush,
  };
}
