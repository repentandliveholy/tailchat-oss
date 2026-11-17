import { randomUUID } from 'node:crypto';

const MAX_NAME_LENGTH = 24;
const MAX_MESSAGE_LENGTH = 4000;

export function normalizeGatewayName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

export class GatewayRoom {
  constructor({ idFactory = randomUUID, now = Date.now } = {}) {
    this.idFactory = idFactory;
    this.now = now;
    this.clients = new Map();
  }

  connect(send) {
    const client = {
      id: this.idFactory(),
      name: null,
      peerId: null,
      send,
      closed: false,
    };
    this.clients.set(client.id, client);

    return {
      id: client.id,
      receive: (payload) => this.#receive(client, payload),
      close: () => this.#disconnect(client),
    };
  }

  #receive(client, payload) {
    if (client.closed || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return;
    }

    if (payload.type === 'hello') {
      this.#hello(client, payload.name);
      return;
    }

    if (!client.name) {
      this.#error(client, 'hello_required', 'Сначала укажите имя.');
      return;
    }

    if (payload.type === 'peer') {
      this.#pair(client, payload.peer);
    } else if (payload.type === 'message') {
      this.#message(client, payload.text);
    } else if (payload.type === 'leave') {
      this.#unpair(client, 'Вы завершили разговор.');
    } else if (payload.type === 'who') {
      this.#sendUsers(client);
    } else {
      this.#error(client, 'unknown_action', 'Неизвестная команда.');
    }
  }

  #hello(client, requestedName) {
    if (client.name) {
      this.#error(client, 'already_joined', 'Имя уже выбрано.');
      return;
    }

    const baseName = normalizeGatewayName(requestedName);
    if (!baseName) {
      this.#error(client, 'invalid_name', 'Введите имя: буквы, цифры, пробел, точка, дефис или подчёркивание.');
      return;
    }

    client.name = this.#uniqueName(baseName, client.id);
    this.#send(client, {
      type: 'welcome',
      self: { id: client.id, name: client.name },
    });
    this.#broadcastUsers();
  }

  #uniqueName(baseName, ownId) {
    const used = new Set(
      [...this.clients.values()]
        .filter((candidate) => candidate.id !== ownId && candidate.name)
        .map((candidate) => candidate.name.toLocaleLowerCase('ru')),
    );
    if (!used.has(baseName.toLocaleLowerCase('ru'))) return baseName;

    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const suffixText = `-${suffix}`;
      const candidate = `${baseName.slice(0, MAX_NAME_LENGTH - suffixText.length)}${suffixText}`;
      if (!used.has(candidate.toLocaleLowerCase('ru'))) return candidate;
    }
    return `${baseName.slice(0, 15)}-${clientSafeId(ownId)}`;
  }

  #pair(client, peerReference) {
    if (client.peerId) {
      this.#error(client, 'already_paired', 'Сначала завершите текущий разговор командой /leave.');
      return;
    }

    const reference = String(peerReference ?? '').trim();
    const referenceLower = reference.toLocaleLowerCase('ru');
    const peer = [...this.clients.values()].find((candidate) => (
      candidate.name
      && candidate.id !== client.id
      && (candidate.id === reference || candidate.name.toLocaleLowerCase('ru') === referenceLower)
    ));

    if (!peer) {
      this.#error(client, 'peer_not_found', 'Собеседник не найден. Обновите список и попробуйте снова.');
      return;
    }
    if (peer.peerId) {
      this.#error(client, 'peer_busy', `${peer.name} уже разговаривает.`);
      return;
    }

    client.peerId = peer.id;
    peer.peerId = client.id;
    this.#send(client, { type: 'paired', peer: { id: peer.id, name: peer.name } });
    this.#send(peer, { type: 'paired', peer: { id: client.id, name: client.name } });
    this.#broadcastUsers();
  }

  #message(client, value) {
    const text = String(value ?? '').trim();
    if (!text) return;
    if (text.length > MAX_MESSAGE_LENGTH) {
      this.#error(client, 'message_too_long', `Сообщение длиннее ${MAX_MESSAGE_LENGTH} символов.`);
      return;
    }

    const peer = client.peerId ? this.clients.get(client.peerId) : null;
    if (!peer || peer.closed) {
      client.peerId = null;
      this.#error(client, 'not_paired', 'Сначала выберите собеседника.');
      this.#broadcastUsers();
      return;
    }

    const base = {
      type: 'message',
      from: { id: client.id, name: client.name },
      text,
      at: this.now(),
    };
    this.#send(client, { ...base, own: true });
    this.#send(peer, { ...base, own: false });
  }

  #disconnect(client) {
    if (client.closed) return;
    client.closed = true;
    this.#unpair(client, `${client.name ?? 'Собеседник'} отключился.`);
    this.clients.delete(client.id);
  }

  #unpair(client, reason) {
    const peer = client.peerId ? this.clients.get(client.peerId) : null;
    client.peerId = null;
    if (peer) {
      peer.peerId = null;
      this.#send(peer, { type: 'unpaired', reason });
    }
    if (client.name && !client.closed) {
      this.#send(client, { type: 'unpaired', reason });
    }
    if (peer || client.name) this.#broadcastUsers();
  }

  #sendUsers(client) {
    this.#send(client, {
      type: 'users',
      users: this.#usersFor(client),
    });
  }

  #broadcastUsers() {
    for (const client of this.clients.values()) {
      if (client.name && !client.closed) this.#sendUsers(client);
    }
  }

  #usersFor(client) {
    return [...this.clients.values()]
      .filter((candidate) => candidate.name && candidate.id !== client.id && !candidate.closed)
      .map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        busy: Boolean(candidate.peerId),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, 'ru'));
  }

  #error(client, code, message) {
    this.#send(client, { type: 'error', code, message });
  }

  #send(client, payload) {
    if (client.closed) return;
    try {
      client.send(payload);
    } catch {
      this.#disconnect(client);
    }
  }
}

function clientSafeId(id) {
  return String(id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'guest';
}
