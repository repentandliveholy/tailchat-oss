const elements = {
  connection: document.querySelector('#connection'),
  connectionLabel: document.querySelector('#connection-label'),
  selfName: document.querySelector('#self-name'),
  peerName: document.querySelector('#peer-name'),
  people: document.querySelector('#people-list'),
  messages: document.querySelector('#messages'),
  emptyState: document.querySelector('#empty-state'),
  composer: document.querySelector('#composer'),
  messageInput: document.querySelector('#message-input'),
  sendButton: document.querySelector('#send-button'),
  leaveButton: document.querySelector('#leave-button'),
  joinScreen: document.querySelector('#join-screen'),
  joinForm: document.querySelector('#join-form'),
  nameInput: document.querySelector('#name-input'),
  joinError: document.querySelector('#join-error'),
};

let socket = null;
let requestedName = readSavedName();
let self = null;
let peer = null;
let users = [];
let reconnectTimer = null;
let reconnectDelay = 1000;

if (requestedName) elements.nameInput.value = requestedName;
elements.nameInput.focus();

elements.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = elements.nameInput.value.trim();
  if (!name) return;
  requestedName = name;
  saveName(name);
  elements.joinError.textContent = '';
  connect();
});

elements.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = elements.messageInput.value.trim();
  if (!text || !peer) return;
  send({ type: 'message', text });
  elements.messageInput.value = '';
  resizeComposer();
  elements.messageInput.focus();
});

elements.messageInput.addEventListener('input', resizeComposer);
elements.leaveButton.addEventListener('click', () => send({ type: 'leave' }));
window.addEventListener('online', () => {
  if (requestedName && (!socket || socket.readyState >= WebSocket.CLOSING)) connect();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && requestedName && (!socket || socket.readyState >= WebSocket.CLOSING)) connect();
});

function connect() {
  if (!requestedName || (socket && socket.readyState < WebSocket.CLOSING)) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  setConnection('connecting', 'Подключение…');

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const nextSocket = new WebSocket(`${protocol}//${location.host}/tailchat/ws`);
  socket = nextSocket;

  nextSocket.addEventListener('open', () => {
    if (socket !== nextSocket) return;
    reconnectDelay = 1000;
    nextSocket.send(JSON.stringify({ type: 'hello', name: requestedName }));
  });

  nextSocket.addEventListener('message', (event) => {
    if (socket !== nextSocket) return;
    try {
      handleEvent(JSON.parse(event.data));
    } catch {
      addSystemMessage('Получен некорректный ответ.');
    }
  });

  nextSocket.addEventListener('close', () => {
    if (socket !== nextSocket) return;
    setConnection('offline', 'Нет связи');
    setPeer(null);
    setComposerEnabled(false);
    if (self) addSystemMessage('Связь прервалась. Подключаемся снова…');
    scheduleReconnect();
  });

  nextSocket.addEventListener('error', () => {
    if (socket === nextSocket && !self) {
      elements.joinError.textContent = 'Шлюз сейчас недоступен. Повторяем подключение…';
    }
  });
}

function scheduleReconnect() {
  if (!requestedName || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
}

function handleEvent(event) {
  if (event.type === 'welcome') {
    self = event.self;
    elements.selfName.textContent = self.name;
    elements.joinScreen.hidden = true;
    elements.joinError.textContent = '';
    setConnection('online', 'На линии');
  } else if (event.type === 'users') {
    users = Array.isArray(event.users) ? event.users : [];
    renderUsers();
  } else if (event.type === 'paired') {
    const changedPeer = !peer || peer.id !== event.peer.id;
    setPeer(event.peer);
    if (changedPeer) {
      clearMessages();
      addSystemMessage(`Разговор с ${event.peer.name} начат.`);
    }
  } else if (event.type === 'unpaired') {
    if (peer) addSystemMessage(event.reason || 'Разговор завершён.');
    setPeer(null);
  } else if (event.type === 'message') {
    addMessage(event);
  } else if (event.type === 'error') {
    if (!self) elements.joinError.textContent = event.message || 'Не удалось войти.';
    else addSystemMessage(event.message || 'Запрос не выполнен.');
  }
}

function renderUsers() {
  elements.people.replaceChildren();
  if (!users.length) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'Сейчас кроме вас никого нет.';
    elements.people.append(note);
    return;
  }

  for (const user of users) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'person';
    button.textContent = user.busy ? `${user.name} · занят` : user.name;
    button.disabled = user.busy || Boolean(peer);
    button.addEventListener('click', () => send({ type: 'peer', peer: user.id }));
    elements.people.append(button);
  }
}

function setPeer(nextPeer) {
  peer = nextPeer;
  elements.peerName.textContent = peer ? peer.name : 'выберите';
  elements.leaveButton.hidden = !peer;
  setComposerEnabled(Boolean(peer) && socket?.readyState === WebSocket.OPEN);
  renderUsers();
}

function setComposerEnabled(enabled) {
  elements.messageInput.disabled = !enabled;
  elements.sendButton.disabled = !enabled;
  elements.messageInput.placeholder = enabled ? 'Напишите сообщение' : 'Сначала выберите собеседника';
}

function addMessage(event) {
  elements.emptyState.hidden = true;
  const row = document.createElement('div');
  row.className = `message-row${event.own ? ' own' : ''}`;

  const message = document.createElement('article');
  message.className = 'message';

  const author = document.createElement('span');
  author.className = 'message-author';
  author.textContent = event.own ? 'ВЫ' : event.from.name;

  const text = document.createElement('p');
  text.className = 'message-text';
  text.textContent = event.text;

  message.append(author, text);
  row.append(message);
  elements.messages.append(row);
  scrollToLatest();
}

function addSystemMessage(text) {
  if (!text) return;
  elements.emptyState.hidden = true;
  const note = document.createElement('p');
  note.className = 'system-message';
  note.textContent = text;
  elements.messages.append(note);
  scrollToLatest();
}

function clearMessages() {
  for (const child of [...elements.messages.children]) {
    if (child !== elements.emptyState) child.remove();
  }
  elements.emptyState.hidden = true;
}

function scrollToLatest() {
  requestAnimationFrame(() => {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  });
}

function resizeComposer() {
  elements.messageInput.style.height = 'auto';
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 120)}px`;
}

function setConnection(state, label) {
  elements.connection.dataset.state = state;
  elements.connectionLabel.textContent = label;
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function readSavedName() {
  try {
    return localStorage.getItem('tailchat-gateway-name') || '';
  } catch {
    return '';
  }
}

function saveName(name) {
  try {
    localStorage.setItem('tailchat-gateway-name', name);
  } catch {
    // Private browsing may reject storage; the active session still works.
  }
}
