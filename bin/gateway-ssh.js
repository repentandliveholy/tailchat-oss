#!/usr/bin/env node
import net from 'node:net';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';

const host = process.env.TAILCHAT_GATEWAY_SSH_HOST || '127.0.0.1';
const port = parsePort(process.env.TAILCHAT_GATEWAY_SSH_PORT, 7682);
const defaultName = `Guest-${randomBytes(2).toString('hex')}`;
const socket = net.createConnection({ host, port });
const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const input = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal,
  historySize: 0,
});

let joined = false;
let users = [];
let buffer = '';

socket.setEncoding('utf8');
socket.setNoDelay(true);
socket.once('connect', () => {
  process.stdout.write('Tailchat — облачный шлюз OVH\n');
  input.question(`Ваше имя [${defaultName}]: `, (answer) => {
    send({ type: 'hello', name: answer.trim() || defaultName });
    input.on('line', handleLine);
  });
});

socket.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handleEvent(JSON.parse(line));
      } catch {
        print('Шлюз прислал некорректный ответ.');
      }
    }
    newline = buffer.indexOf('\n');
  }
});

socket.once('error', (error) => {
  process.stderr.write(`Не удалось подключиться к шлюзу: ${error.message}\n`);
  input.close();
  process.exitCode = 1;
});

socket.once('close', () => {
  if (joined) process.stdout.write('\nСоединение со шлюзом закрыто.\n');
  input.close();
});

input.once('SIGINT', () => {
  socket.end();
});

function handleLine(line) {
  const text = line.trim();
  if (!text) {
    prompt();
    return;
  }
  if (text === '/quit' || text === '/exit') {
    socket.end();
    return;
  }
  if (text === '/help') {
    printHelp();
  } else if (text === '/who') {
    printUsers();
    send({ type: 'who' });
  } else if (text === '/leave') {
    send({ type: 'leave' });
  } else if (text.startsWith('/peer ')) {
    send({ type: 'peer', peer: text.slice(6).trim() });
  } else if (text.startsWith('/')) {
    print('Команда не найдена. Введите /help.');
  } else {
    send({ type: 'message', text });
  }
  prompt();
}

function handleEvent(event) {
  if (event.type === 'welcome') {
    joined = true;
    print(`Вы вошли как ${event.self.name}.`);
    printHelp();
  } else if (event.type === 'users') {
    users = Array.isArray(event.users) ? event.users : [];
    printUsers();
  } else if (event.type === 'paired') {
    print(`Разговор с ${event.peer.name} начат.`);
  } else if (event.type === 'unpaired') {
    print(event.reason || 'Разговор завершён.');
  } else if (event.type === 'message') {
    print(`${event.own ? 'Вы' : event.from.name}: ${event.text}`);
  } else if (event.type === 'error') {
    print(event.message || 'Запрос не выполнен.');
  }
}

function printHelp() {
  print('/peer ИМЯ — выбрать собеседника\n/who — показать пользователей\n/leave — завершить разговор\n/quit — выйти');
}

function printUsers() {
  const available = users.filter((user) => !user.busy);
  const busy = users.filter((user) => user.busy);
  if (!users.length) {
    print('Сейчас кроме вас никого нет. Оставьте окно открытым.');
    return;
  }
  const lines = [];
  if (available.length) lines.push(`Свободны: ${available.map((user) => user.name).join(', ')}`);
  if (busy.length) lines.push(`Разговаривают: ${busy.map((user) => user.name).join(', ')}`);
  print(lines.join('\n'));
}

function print(text) {
  process.stdout.write(`\n${text}\n`);
  prompt();
}

function prompt() {
  if (joined && !input.closed) input.prompt(true);
}

function send(payload) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}
