# Tailchat Cloud: аккаунты, реле кадров, веб-клиент

Статус: реализуется (0.59.0). Этот файл — единственный источник истины по протоколу.
Все части (сервер, клиентский транспорт, веб-клиент) пишутся строго по нему.

## Цель

Три входа в один и тот же разговор:

1. `tailchat` — как раньше: P2P внутри tailnet, без сервера. **Ничего не меняется.**
2. `tailchat --cloud` — тот же TUI, но канал идёт через облачный сервер на OVH.
   Логин/пароль, список пользователей со статусами, доставка сообщений, отправленных
   пока адресат был выключен.
3. `https://<домен>/cloud/` — веб-клиент в браузере: логин/регистрация, колонка
   пользователей со статусами, переписка с историей.

## Инварианты проекта (не нарушать)

- Сервер OVH строго необязателен. Без `--cloud` клиент вообще не обращается к нему.
- Слово «демон/daemon» в текстах и коде запрещено.
- Старый путь `/chat/` не обслуживается. Терминальный UI в браузер не проксируется
  (никаких `xterm`/`ttyd`). Существующий шлюз (`/tailchat/`, порт 7681) остаётся
  как есть — облако живёт рядом, на своём порту и своём пути.
- Никаких новых зависимостей: только `ws` (уже есть) и `node:crypto`/`node:fs`.
  Тесты — только `node:test`.
- Сообщения в DOM добавляются только через `textContent`. Бинарные WS-кадры не принимаются.
- Все строки CLI идут через `src/i18n.js` во всех трёх словарях (en/ru/fr).

## Ключевое решение: облако реле́ит кадры, а не «сообщения»

У Tailchat уже есть полный протокол кадров (NDJSON, `src/frames.js`,
разбор в `src/session.js:48-137`): `hello, msg, ai, ack, read, typing, focus,
wake, logo, holiday, bye, devices, update, caps, ping, pong, file-offer,
file-chunk, file-done, file-deny`.

Облачный сервер переносит **эти же кадры** между аккаунтами. Следствия:

- TUI, чек-марки, файлы, «печатает…», присутствие, AI, логотип, праздничный режим
  работают в облаке без единой правки в `src/ui.js`.
- Клиентский транспорт переиспользует `createConnection` из `src/session.js`,
  подсовывая ему виртуальный сокет над WebSocket.
- Веб-клиент говорит на том же языке кадров (`msg`/`ack`/`read`/`typing`/`hello`),
  поэтому браузер и терминал совместимы между собой.

Сервер разбирает только `d.t`, чтобы решить, что положить в очередь для
отключённого адресата. Смысла кадров он не знает.

## Транспорт и пути

Отдельная служба, отдельный порт, отдельный PM2-процесс:

| Что | Значение |
| --- | --- |
| HTTP+WS порт | `127.0.0.1:7683`, env `TAILCHAT_CLOUD_PORT`, `TAILCHAT_CLOUD_HOST` |
| Публичный путь | `https://<домен>/cloud/` (Caddy сохраняет префикс) |
| Статика | `GET /cloud/`, `/cloud/app.js`, `/cloud/app.css` из `web/cloud/` |
| API | `/cloud/api/*` |
| WebSocket | `/cloud/ws` |
| Здоровье | `GET /health` → `{"ok":true}` |
| Данные | `TAILCHAT_CLOUD_DATA`, по умолчанию `~/.tailchat-cloud` |
| PM2 | приложение `tailchat-cloud` → `bin/cloud-server.js` |

Заголовки ответов — как в `src/gateway-server.js:204-215` (CSP, `X-Frame-Options: DENY`,
`nosniff`, `no-referrer`, `no-store`). Тело запроса к API — не более 8 КиБ.
Кадр WS — не более 320 КиБ (`MAX_FRAME_CHARS` 256 КиБ + конверт).

## Хранилище (`src/cloud/accounts.js`)

Один JSON-файл `accounts.json` в каталоге данных, режим `0600`, запись через
`tmp + rename`, склейка частых записей окном 200 мс + принудительный сброс на выходе.

```
{
  "version": 1,
  "accounts": {
    "<login>": {
      "login": "roman",
      "name": "Роман",
      "salt": "<hex 16>",
      "hash": "<hex 64>",          // scrypt(password, salt, 64), N=16384 r=8 p=1
      "createdAt": 1756500000000,
      "lastSeen": 1756500000000
    }
  },
  "tokens": {
    "<sha256(token) hex>": { "login": "roman", "createdAt": 0, "lastUsed": 0 }
  },
  "friends": {
    "<login>": [ "<friendLogin1>", "<friendLogin2>" ]
  },
  "invites": {
    "<sha256(invite) hex>": { "login": "roman", "createdAt": 1756500000000 }
  },
  "queue":   { "<login>": [ { "from": "<login>", "d": { "t": "msg", ... }, "at": 0 } ] },
  "history": { "<a>|<b>":  [ { "id": "", "from": "", "text": "", "ts": 0, "kind": "human" } ] }
}
```

Правила:

- `login`: приводится к нижнему регистру, затем `/^[a-z0-9][a-z0-9._-]{2,31}$/`.
- `password`: 8–200 символов, любые непустые.
- `name`: через `normalizeGatewayName` (`src/gateway-core.js:6`), пусто → берётся `login`.
- Токен и инвайт: 32 случайных байта в hex. **В файле хранится только sha256 от токена/инвайта.**
- Инвайты: один активный инвайт на аккаунт; создание нового аннулирует предыдущий (ротация).
- Принятие инвайта: одноразовое; запрещён само-инвайт; инвайт удаляется, создаются рёбра дружбы в обе стороны.
- Друзья: списки друзей взаимны. Вновь созданные и существующие аккаунты начинают с пустым списком друзей.
- Очередь: не более 500 кадров на аккаунт, при переполнении выбрасывается самый старый.
- История: ключ — два логина, отсортированные и склеенные `|`; не более 500 записей
  на разговор; доступна только друзьям.
- Пароли/токены никогда не попадают в лог.

Экспорт (обязательные имена):

```js
createAccountStore({ dir, now = Date.now, writeDelayMs = 200 }) -> {
  register({ login, password, name }),   // -> { ok:true, user, token } | { ok:false, code }
  login({ login, password }),            // -> { ok:true, user, token } | { ok:false, code }
  resolveToken(token),                   // -> { login, name } | null   (обновляет lastUsed)
  revokeToken(token),                    // -> boolean
  users(),                               // -> [{ login, name, lastSeen }] по алфавиту (внутренний)
  friends(login),                        // -> [{ login, name, lastSeen }] по алфавиту (друзья)
  areFriends(a, b),                      // -> boolean
  createInvite(login),                   // -> string (raw 32-byte hex token) | null
  acceptInvite(login, token),            // -> { ok:true, friend:{login,name} } | { ok:false, code }
  touch(login, at),                      // обновляет lastSeen
  enqueue(login, item),                  // -> number (размер очереди)
  drain(login, from),                    // -> [item] и удаляет их из очереди
  pending(login),                        // -> { "<from>": count }
  recordHistory(a, b, message),
  history(a, b, limit = 200),            // -> [message] по возрастанию ts
  flush(),                               // -> Promise, дожать запись на диск
  close(),
}
```

Коды ошибок: `invalid_login`, `invalid_password`, `invalid_name`, `login_taken`,
`bad_credentials`, `unknown_token`, `invalid_invite`, `invite_not_found`, `self_invite`.

## HTTP API

Все ответы — JSON. Ошибка: `{ "error": "<code>", "message": "<человеческая строка>" }`.
Авторизация: `Authorization: Bearer <token>`; без него или с плохим токеном → `401 unknown_token`.

| Метод и путь | Тело | Ответ |
| --- | --- | --- |
| `POST /cloud/api/register` | `{login,password,name}` | `201 {token, user:{login,name}, recoveryKey}`; `400 invalid_*`; `409 login_taken`; `429 too_many_attempts` |
| `POST /cloud/api/login` | `{login,password}` | `200 {token, user}`; `401 bad_credentials`; `429 too_many_attempts` |
| `POST /cloud/api/recover` | `{login,recoveryKey,newPassword}` | `200 {token, user, newRecoveryKey}`; `400 invalid_*`; `401 bad_recovery_key`; `429 too_many_attempts` |
| `POST /cloud/api/logout` | — | `204`; токен аннулирован |
| `POST /cloud/api/invite` | — | `201 {invite:"<64 hex>"}` |
| `POST /cloud/api/invite/accept` | `{invite}` | `200 {friend:{login,name}}`; `400 invalid_invite`/`self_invite`; `404 invite_not_found` |
| `GET /cloud/api/users` | — | `200 {users:[{login,name,online,lastSeen,pending}]}` (только друзья, без себя) |
| `GET /cloud/api/history?peer=<login>&limit=200` | — | `200 {messages:[{id,from,text,ts,kind}]}`; `403 not_friends`; `400 invalid_login` |
| `GET /cloud/api/me` | — | `200 {user:{login,name}}` — проверка живости токена |

Ограничитель попыток: на IP не более 10 неудачных `login`/`register` за 15 минут и
не более 5 успешных регистраций за час; счётчик в памяти, окно скользящее.

## WebSocket `/cloud/ws`

Токен **не передаётся в URL** (он попал бы в логи прокси). Первый кадр от клиента —
`auth`; на него даётся 5 секунд, иначе соединение закрывается кодом `4401`.

Клиент → сервер:

| `k` | Поля | Смысл |
| --- | --- | --- |
| `auth` | `token` | единственный допустимый первый кадр |
| `subscribe` | `peer` | выбрать собеседника; ровно одна подписка на соединение |
| `frame` | `to`, `d` | переслать кадр протокола Tailchat аккаунту `to` |
| `who` | — | запросить список пользователей |

Сервер → клиент:

| `k` | Поля |
| --- | --- |
| `ready` | `self:{login,name}`, `users:[...]` |
| `users` | `users:[{login,name,online,lastSeen,pending}]` |
| `subscribed` | `peer`, `online`, `pending` (число выданных из очереди кадров) |
| `frame` | `from`, `d` |
| `presence` | `peer`, `online` |
| `error` | `code`, `message` |

Правила маршрутизации:

- Кадр доставляется только тем соединениям адресата, которые подписаны на отправителя.
- Если ни одного такого соединения нет: кадры с `d.t` из `{msg, ai, ack, read}`
  кладутся в очередь; остальные (`typing, focus, ping, pong, wake, logo, holiday,
  caps, devices, update, file-*`, `hello`) отбрасываются — они бессмысленны позже.
- `msg` и `ai` дополнительно пишутся в историю разговора.
- `subscribe` немедленно выдаёт очередь от этого собеседника отдельными `frame`,
  затем `subscribed`.
- Появление/уход собеседника рассылается подписчикам как `presence`; всем
  авторизованным соединениям рассылается обновлённый `users`.
- 30-секундный ping/pong, `terminate()` при пропущенном pong (как `gateway-server.js:83-92`).
- Ошибки: `auth_required`, `auth_failed`, `invalid_json`, `unknown_action`,
  `peer_not_found`, `not_subscribed`, `frame_too_large`, `rate_limited`.

### Ядро маршрутизации (`src/cloud/hub.js`)

Транспорт не знает о WebSocket — ровно как `GatewayRoom`:

```js
createCloudHub({
  store,                       // createAccountStore(...)
  now = Date.now,
  authTimeoutMs = 5000,
  frameRateLimit = 60,         // кадров `frame` в секунду на соединение
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) -> {
  connect(send, { close }) -> { id, login(), receive(payload), close() },
  onlineLogins() -> Set<string>,
  isOnline(login) -> boolean,
}
```

`send(payloadObject)` отправляет кадр этому соединению; `close(code)` — просьба
хаба к транспорту разорвать соединение (WS-код 4401 для провала авторизации,
4429 для превышения ограничителя). Возвращаемый объект: `receive(payload)`
принимает уже разобранный JSON-объект, `close()` вызывается транспортом при
разрыве соединения. Пока не пришёл `auth`, любой другой `k` даёт
`error auth_required`; по истечении `authTimeoutMs` — `error auth_failed` и
`close(4401)`. После этого хаб не отправляет в это соединение ничего.

Ограничитель на соединение: не более 60 кадров `frame` в секунду; превышение →
`error rate_limited` и разрыв.

## Клиентский транспорт TUI (`src/cloud/link.js`)

`startCloudSession(...)` возвращает объект, полностью совместимый с `rz` из
`startRendezvous` (`src/rendezvous.js:95-535`), поэтому в `src/cli.js:2117`
достаточно ветки. Внутри:

1. WebSocket к серверу, `auth`, `subscribe` на выбранного собеседника.
2. Виртуальный сокет (`net.Socket`-подобный) над WS: `write` упаковывает NDJSON-строку
   в `{k:'frame', to, d}`, входящие `frame` отдаются как `data`.
3. `createConnection(socket, { name, connId, initiatedByMe: true })` — весь разбор
   кадров переиспользуется.
4. Когда сервер сообщает, что собеседник вошёл в сеть, виртуальный канал
   пересоздаётся: новый `connId`, новый `hello`. Это ровно та же семантика, что и
   переподключение в P2P, и поэтому `hello` не нужно хранить в очереди.
5. Переподключение к серверу: 1 с → 30 с с ростом задержки; `status`-строки идут
   через новые ключи `cloud.*`.

Обязательные события: `online {peerName,peerVersion,remoteAddress}`, `offline`,
`reaching {active}`, `status {key,params}`, `message`, `ai`, `ack`, `read`, `typing`,
`focus`, `wake`, `logo`, `holiday`, `caps`, `update`, `devices`, `ping`, `pong`, `bye`,
`file-offer`, `file-chunk`, `file-done`, `file-deny`.

Обязательные методы: `send`, `sendFrame`, `sendReceipt`, `sendPing`, `writable`,
`writeFrame`, `flushed`, `isOnline`, `isDialling`, `boundPort` (→ `null`), `target`,
`targets`, `setTarget`, `setTargets`, `refreshAllowed`, `retryDelay`, `activeSocket`,
`reconnect`, `standDown`, `stop`.

## CLI

- `--cloud` — включить облачный режим; адрес собеседника не требуется.
- `--cloud-server <url>` — адрес сервера; иначе `config.cloudServer`,
  иначе значение по умолчанию из `src/cloud/config.js`.
- `--cloud-logout` — забыть токен и выйти.
- Позиционный аргумент в облачном режиме — логин собеседника, а не адрес.

Хранение: `config.cloudServer`, `config.cloudLogin` — в `config.json` через `persist`;
токен — в `secrets.env` под именем `TAILCHAT_CLOUD_TOKEN` (`writeSecret`/`readSecrets`,
`src/config.js:86`).

Порядок в облачном режиме (до создания TUI, терминал ещё «плоский»):
проверка токена → при необходимости логин/регистрация (readline, пароль без эха) →
список пользователей → выбор собеседника через `runListMenu` со статусами →
`startCloudSession` → обычный TUI.

Пропускается: `findTailscaleCli`, `probeTailscaleStatus`, `resolvePeerIdentity`,
`choosePeer`, `detectBindAddr`, `pausePm2Daemon`, заметка о слушателе порта.

## Веб-клиент (`web/cloud/`)

Без сборки, без фреймворка, ES-модулей не требуется. Файлы: `index.html`, `app.js`, `app.css`.

Экран входа: логин, пароль, кнопка «Войти» и переключение на регистрацию (логин,
имя, пароль). Токен — в `localStorage['tailchat-cloud-token']`, проверяется
через `GET /cloud/api/me`.

Основной экран: слева колонка пользователей (имя, `● в сети` / `○ был(а) …`,
счётчик непрочитанных), справа переписка и поле ввода. При выборе собеседника —
`GET /cloud/api/history`, затем `subscribe`. Отправка — `{k:'frame', to, d:{t:'msg', id, text, ts}}`.
Приём `msg` → `ack`, при видимой вкладке → `read`. Свои сообщения помечаются
`✓` по `ack` и `✓✓` по `read`. `typing` — при вводе, «печатает…» у собеседника.
Переподключение 1 с → 10 с, повтор при `online` и `visibilitychange`.
Ширина от 360 px без горизонтальной прокрутки, `100dvh`, safe-area.

## Тесты (`node:test`)

- `test/cloud-accounts.test.js` — регистрация/логин/токены, коды ошибок, очередь и
  её предел, история и её предел, устойчивость к битому файлу.
- `test/cloud-hub.test.js` — маршрутизация подписчикам, очередь только для
  `msg/ai/ack/read`, выдача очереди при `subscribe`, присутствие, ограничители.
- `test/cloud-server.test.js` — HTTP: коды ответов, заголовки, `401` без токена,
  `/health`, статика только из `/cloud/`; WS: `auth` обязателен первым, тайм-аут,
  два клиента обмениваются кадрами.
- `test/cloud-link.test.js` — сквозная проверка: два `startCloudSession` против
  реального сервера в процессе обмениваются `msg`, получают `ack`/`read`,
  доставка из очереди после переподключения.
