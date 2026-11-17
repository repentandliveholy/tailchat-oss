# Развёртывание Tailchat Cloud на OVH

Облачная служба (`tailchat-cloud`) живёт рядом с существующим шлюзом
(`tailchat-gateway`, порт 7681) и ничего в нём не меняет. Отдельный порт, отдельный
путь, отдельное приложение PM2, отдельный каталог данных.

**P2P-режим от всего этого не зависит.** Обычный `tailchat` внутри tailnet работает
без сервера OVH: если облако выключено, сломано или вовсе не развёрнуто, P2P-канал
между двумя машинами продолжает работать как раньше. Облако — это третий вход в тот
же разговор, а не его условие.

Исходные данные боевой машины:

| Что | Значение |
| --- | --- |
| Публичный адрес | `203.0.113.10` |
| Домен | `repentandliveholy.org` |
| Репозиторий | `/opt/tailchat` |
| TLS | завершает Caddy |
| Приложение PM2 | `tailchat-gateway` (порт 7681, внутренний P2P-шлюз) |
| Облачное приложение PM2 | `tailchat-cloud` (порт 7683, публичный путь `/tailchat/`) |
| Каталог данных | `/var/lib/tailchat-cloud` |

## 1. Обновить код безопасно

```bash
cd /opt/tailchat
node bin/production-deploy.js
```

Скрипт останавливается до изменения checkout, если изменён любой tracked-файл или
если обязательные маркеры пропали из `/etc/caddy/Caddyfile` либо
`/home/godsheep/.tailik/gateway.mjs`. Untracked runtime-файлы сохраняются, но после
`git fetch` скрипт проверяет их точные пути против дерева target commit и
останавливается при любом пересечении. Затем он фиксирует исходный commit,
переключается на `origin/main` и запускает `npm ci --omit=dev`. Если reset или
установка зависимостей завершаются ошибкой, скрипт возвращает исходный commit и
повторно устанавливает его зависимости до перезапуска процессов.

PM2 обновляется через `ecosystem.config.cjs` только для приложений, которых касаются
изменённые пути. Команда `pm2 restart all` не используется; внешний процесс
`tailik` этот deploy не перезапускает.

Первый переход со старой версии, в которой `bin/production-deploy.js` ещё нет,
нужно выполнить вручную с теми же проверками. Все последующие релизы идут только
через скрипт.

Шага сборки нет.

### Отчёт о деплое в Telegram

После каждого запуска (успешного и нет) скрипт отправляет одно текстовое
сообщение: версия, commit, перезапущенные приложения — либо причина отказа и
удержался ли откат. Канал берётся из двух переменных,
`TAILCHAT_DEPLOY_TG_TOKEN` и `TAILCHAT_DEPLOY_TG_CHAT`. Их незачем
экспортировать: `loadDeployEnv()` (`src/deploy-notify.js`) читает их из
`/opt/tailchat/.env` — файл вне git (`.gitignore`), 0600, имена описаны в
`.env.example`, и как untracked-файл он сохраняется между деплоями. Читаются
ровно эти два имени, так что `.env` не может подложить деплою ничего другого;
уже экспортированное значение имеет приоритет над файлом.

Если канал не настроен, деплой ведёт себя как раньше и молчит: отправка —
best-effort с таймаутом 5 с и никогда не меняет код возврата деплоя.

## 2. Создать каталог данных

Внутри лежит единственный файл `accounts.json` с логинами, солями, scrypt-хешами
паролей, sha256 от токенов, очередью недоставленных кадров и историей разговоров.
Пароли и сами токены в нём не хранятся, но читать его посторонним всё равно нечего.

```bash
sudo install -d -m 700 -o godsheep -g godsheep /var/lib/tailchat-cloud

Вместо `tailchat:tailchat` подставьте пользователя, под которым работает PM2 (это тот
же пользователь, от имени которого вы запускаете `pm2 status`; если PM2 поднят через
`pm2 startup` от root — значит `root:root`). Права `700` обязательны: служба сама
создаёт каталог с этим режимом и пишет `accounts.json` в режиме `0600`.

## 3. Запустить службу под PM2

`ecosystem.config.cjs` уже содержит второе приложение. Флаг `--only` важен: без него
`pm2 start` перезапустил бы и шлюз.

```bash
cd /opt/tailchat
pm2 start ecosystem.config.cjs --only tailchat-cloud
pm2 save
pm2 status
```

В `pm2 status` должны быть две строки `online`: `tailchat-gateway` и `tailchat-cloud`.
Переменные окружения приложение берёт из конфигурации:

```
NODE_ENV=production
TAILCHAT_CLOUD_HOST=127.0.0.1
TAILCHAT_CLOUD_PORT=7683
TAILCHAT_CLOUD_DATA=/var/lib/tailchat-cloud
TAILCHAT_CLOUD_TRUST_PROXY=1
```

`TAILCHAT_CLOUD_TRUST_PROXY=1` разрешает службе доверять заголовку
`X-Forwarded-For` — и только потому, что единственная дверь снаружи это Caddy.
Служба слушает `127.0.0.1`, поэтому напрямую подделать заголовок из интернета
нельзя. Если когда-нибудь порт 7683 окажется открыт наружу, эту переменную нужно
убрать: иначе ограничитель попыток входа обходится одним лишним заголовком.

**С версии 1.34 это ещё и проверяется на старте.** Без флага (и без явного
`trustProxy` в вызове) служба на loopback-адресе отказывается запускаться:

```
Tailchat cloud: refusing to listen on the loopback address 127.0.0.1 without
TAILCHAT_CLOUD_TRUST_PROXY=1. ...
```

Причина в том, что без флага `clientAddress` возвращает `127.0.0.1` для всех, и
ограничитель попыток входа получает одну общую корзину на весь деплой: десять
неудачных логинов от кого угодно закрывают `/api/login`, `/api/register` и
`/api/recover` для всех на 15 минут, причём в логах это ничем не отличается от
лимита кадров WebSocket. Именно так `pm2 resurrect` после ребута и `pm2 restart`
без `--update-env` ломали вход «сами по себе» — переменная терялась молча.
Поэтому после любого рестарта проверяй окружение процесса:

```
tr '\0' '\n' < /proc/$(pgrep -f cloud-server.js | head -1)/environ | grep TAILCHAT_
```

Локальный запуск на своей машине — то же самое: либо
`TAILCHAT_CLOUD_TRUST_PROXY=1`, либо явный `trustProxy: false` в опциях
`createCloudService` (означает «да, у меня одна общая корзина, я знаю»).

### AI-мост (Тайлик в cloud-web)

Терминал отвечает на `/ai`/упоминания сам, локальным ключом (`GEMINI_API_KEY` в
секретах терминала). Веб-клиент не держит ключей вообще и без этого моста никогда
не получит ответ, если ни у кого из собеседников в этот момент не запущен терминал.

`src/cloud/ai-bridge.js` не хранит и не запрашивает ключ Gemini вообще — он
проксирует запрос в уже существующий `~/.tailik/gateway.mjs` (порт `4748` на
Tailscale-адресе машины). Ключ остаётся ровно в одном месте
(`~/.tailik/secrets.env`), gateway уже умеет context/restart/clear-команды —
второй copy этой логики в cloud-сервере нет. Авторизация — та же, что у
терминала: gateway проверяет `tailscale whois` вызывающего адреса против
`config.allowedLogin`; поскольку `tailchat-cloud` и `gateway.mjs` работают на
одной машине, самообращение по Tailscale-адресу уже проходит эту проверку
(проверено: `curl http://100.64.0.10:4748/v1/history/messages?...` с самой
машины отвечает `200`, не `403`).

```
TAILCHAT_CLOUD_AI_OWNER=<login владельца>
TAILCHAT_CLOUD_AI_GATEWAY_URL=http://100.64.0.10:4748/v1/chat/completions
```

Без обеих переменных мост выключен полностью — поведение не меняется
относительно того, что было до него. Когда обе заданы, мост отвечает на
упоминания «tailik» / «тайлик» / «тэйлик» в любом разговоре, где одна из
сторон — `TAILCHAT_CLOUD_AI_OWNER` (вторая сторона обязана быть в друзьях:
`hub.js`-`subscribe()` не пускает в разговор никого другого), с тем же
лимитом ~15 запросов в минуту, что у одной терминальной сессии
(`AI_THROTTLE_MS` из `src/ai.js`) — единый счётчик на весь мост, а не на
каждый разговор отдельно.

Статус виден без чтения кода: ready-строка `tailchat-cloud` в логах PM2
заканчивается на `ai-bridge: enabled`/`disabled`, и `GET /health` отдаёт
`{"ok":true,"aiBridge":true|false}`.

## 4. Caddy: путь `/tailchat/*`

В `/etc/caddy/Caddyfile`, в блоке домена:

```caddyfile
repentandliveholy.org {
	@tailchat path /tailchat /tailchat/*
	handle @tailchat {
		reverse_proxy 127.0.0.1:7683 {
			header_up Host {host}
			header_up X-Forwarded-Host {host}
			header_up X-Forwarded-For {remote_host}
		}
	}
}
```

Четыре инварианта, которые проверяет deployment runner:

- публичный маршрут — `/tailchat` и `/tailchat/*`, upstream — облако на
  `127.0.0.1:7683`; gateway на `7681` этим маршрутом не подменяется;
- `handle`, а не `handle_path`: префикс `/tailchat` должен дойти до сервера;
- `Host` и `X-Forwarded-Host` передают исходный домен, иначе same-origin проверка
  WebSocket отклонит подключение за Caddy;
- `X-Forwarded-For` заменяется одним адресом `{remote_host}`, а не доверяет цепочке
  от клиента.

WebSocket-апгрейд `reverse_proxy` в Caddy 2 пробрасывает сам. Проверять нужно
`/tailchat/ws`.

После ручной правки Caddy:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 5. Проверка

Локально, на самой машине:

```bash
curl -s localhost:7683/health
# {"ok":true}
```

Снаружи, через Caddy:

```bash
curl -s https://repentandliveholy.org/health
curl -si https://repentandliveholy.org/tailchat/ | head -1
```

Регистрация и вход (замените логин и пароль):

```bash
curl -s -X POST https://repentandliveholy.org/tailchat/api/register \
  -H 'Content-Type: application/json' \
  -d '{"login":"roman","password":"длинный-пароль","name":"Роман"}'
# {"token":"<64 hex>","user":{"login":"roman","name":"Роман"}}

curl -s -X POST https://repentandliveholy.org/tailchat/api/login \
  -H 'Content-Type: application/json' \
  -d '{"login":"roman","password":"длинный-пароль"}'
# {"token":"<64 hex>","user":{"login":"roman","name":"Роман"}}

TOKEN=<вставьте token>
curl -s https://repentandliveholy.org/tailchat/api/me -H "Authorization: Bearer $TOKEN"
# {"user":{"login":"roman","name":"Роман"}}
curl -s https://repentandliveholy.org/tailchat/api/users -H "Authorization: Bearer $TOKEN"
# {"users":[...]}
```

Токены в командной строке попадают в историю оболочки — после проверки достаточно
`unset TOKEN` и, если хочется, `history -d`. Сам токен аннулируется вызовом
`POST /tailchat/api/logout`.

Не пугайтесь `429 too_many_attempts` при повторных проверках: на один адрес
разрешено 10 неудачных попыток входа за 15 минут и 5 успешных регистраций за час.
Счётчик живёт в памяти, поэтому `pm2 restart tailchat-cloud` его обнуляет.

## 6. Логи

Где лежат логи, что служба в них пишет и что писать в `grep` (`cloud: read`,
`cloud: frame budget`, признак флапа) — `docs/cloud-logs.md`. Здесь это не
повторяется: одно место вместо трёх, которые расходятся.

## 7. Шифрование на сервере, мастер-ключ и резервная копия

Данные сервера на диске (снимок `accounts.json`, журнал коммитов `accounts.journal`,
inline-медиа и секретные sidecar-файлы) зашифрованы AEAD (AES-256-GCM) с проверкой
целостности и версии.

### Мастер-ключ
Мастер-ключ хранится в отдельном файле с правами `0600` вне каталога данных
(например, `/etc/tailchat-cloud/master.key`, 64 hex-символа / 32 байта).
Путь к файлу передаётся через переменную окружения `TAILCHAT_CLOUD_MASTER_KEY_FILE`.

```bash
# Генерация ключа (выполняется один раз оператором):
# Каталог и ключ должны принадлежать пользователю PM2 (на OVH это godsheep)
sudo install -d -m 700 -o godsheep -g godsheep /etc/tailchat-cloud
sudo -u godsheep sh -c 'test -s /etc/tailchat-cloud/master.key || (openssl rand -hex 32 > /etc/tailchat-cloud/master.key && chmod 600 /etc/tailchat-cloud/master.key)'
sudo -u godsheep test -r /etc/tailchat-cloud/master.key && echo "Key ready"
```

**Эскроу ключа:** немедленно скопируйте сгенерированный ключ `/etc/tailchat-cloud/master.key`
в парольный менеджер владельца вне сервера. Без этой независимой копии при выходе из строя
диска сервера вся зашифрованная история и архивы станут безвозвратно нечитаемы.
Ключ резервируется **строго отдельно** от каталога данных и никогда не включается
в общий архив с зашифрованными файлами.

### Инициализация нового хранилища с нуля (без миграции)
Если разворачивается новый сервер без существующей истории:

```bash
node bin/cloud-encrypt.js \
  --init \
  --target /var/lib/tailchat-cloud \
  --key-file /etc/tailchat-cloud/master.key
```
Утилита проверит ключ и создаст маркер `.cloud-encrypted` в пустом каталоге.
Без этого шага сервер с ключом откажется запускаться на пустом каталоге (fail-closed).

### Миграция существующих данных на OVH
Для проведения миграции на сервере используется изолированный рабочий каталог (worktree)
нового кода, чтобы не ломать текущий рабочий каталог до миграции данных:

```bash
# 1. Фиксируем текущий коммит для возможного отката:
sudo install -d -m 700 -o godsheep -g godsheep /var/backups/tailchat-cloud
git -C /opt/tailchat rev-parse HEAD | sudo -u godsheep tee /var/backups/tailchat-cloud/pre-encrypt-commit

# 2. Создаём временный worktree с новым кодом и заранее проверяем зависимости:
cd /opt/tailchat
git fetch origin main
git worktree add /tmp/tc-enc origin/main
cd /tmp/tc-enc && npm ci --omit=dev && cd /opt/tailchat

# 3. Останавливаем службу (начало окна обслуживания):
pm2 stop tailchat-cloud

# 4. Снимаем полный бэкап открытых данных:
sudo -u godsheep tar -czf /var/backups/tailchat-cloud/backup-pre-encrypt-$(date +%F-%H%M).tar.gz \
  -C /var/lib/tailchat-cloud .

# 5. Запускаем оффлайн-миграцию через скрипт из worktree:
node /tmp/tc-enc/bin/cloud-encrypt.js \
  --source /var/lib/tailchat-cloud \
  --target /var/lib/tailchat-cloud-encrypted \
  --key-file /etc/tailchat-cloud/master.key

# 6. Переключаем каталоги данных:
mv /var/lib/tailchat-cloud /var/lib/tailchat-cloud-plaintext
mv /var/lib/tailchat-cloud-encrypted /var/lib/tailchat-cloud

# 7. Удаляем временный worktree:
git worktree remove --force /tmp/tc-enc
# 8. Применяем обновление через стандартный deploy-скрипт:
# (он переключит checkout на origin/main, обновит зависимости,
#  соберёт архив tailchat.tar.gz и перезапустит tailchat-cloud в PM2):
node bin/production-deploy.js || (pm2 stop tailchat-cloud && echo "Deploy failed! Stopped service to protect encrypted data. Proceed to rollback.")

# 9. Проверяем работоспособность:
curl -s localhost:7683/health

# 10. Посточистка открытых копий (после 24-часового окна проверки стабильности):
# Скачайте backup-pre-encrypt-*.tar.gz на защищённый оффлайн-носитель владельца,
# после чего удалите открытый каталог и открытый бэкап с сервера:
# rm -f /var/backups/tailchat-cloud/backup-pre-encrypt-*.tar.gz
# rm -rf /var/lib/tailchat-cloud-plaintext
```
### Резервная копия
Резервируется согласованный срез каталога данных — и снимок `accounts.json`,
и журнал `accounts.journal`:

```bash
sudo install -d -m 700 -o godsheep -g godsheep /var/backups/tailchat-cloud
sudo -u godsheep tar -czf /var/backups/tailchat-cloud/data-$(date +%F-%H%M).tar.gz \
  -C /var/lib/tailchat-cloud .
```

### Восстановление и откат
Восстановление из бэкапа:
```bash
pm2 stop tailchat-cloud
tar -xzf /var/backups/tailchat-cloud/data-2026-09-25.tar.gz -C /var/lib/tailchat-cloud
sudo chown -R godsheep:godsheep /var/lib/tailchat-cloud
sudo chmod 700 /var/lib/tailchat-cloud
sudo chmod 600 /var/lib/tailchat-cloud/* /var/lib/tailchat-cloud/.cloud-encrypted
pm2 startOrReload ecosystem.config.cjs --only tailchat-cloud --update-env
```
Откат на открытый режим (безопасен только в первые 2–3 минуты окна обслуживания,
до приёма новых сообщений от пользователей):
```bash
pm2 stop tailchat-cloud
cd /opt/tailchat
PREV_COMMIT="$(cat /var/backups/tailchat-cloud/pre-encrypt-commit)"
git reset --hard "$PREV_COMMIT"
npm ci --omit=dev
git archive --output=web/cloud/tailchat.tar.gz "$PREV_COMMIT"
# Возвращаем открытый каталог данных:
rm -rf /var/lib/tailchat-cloud
mv /var/lib/tailchat-cloud-plaintext /var/lib/tailchat-cloud
# Перезапускаем службу со старой конфигурацией:
pm2 startOrReload ecosystem.config.cjs --only tailchat-cloud --update-env
curl -s localhost:7683/health
```
## 8. Как теперь подключается пользователь

Терминал (тот же TUI, канал через облако):

```bash
tailchat --cloud --cloud-server https://repentandliveholy.org
```

Адрес сервера запоминается в `config.json`, токен — в `secrets.env`, так что
дальше достаточно `tailchat --cloud`. Выйти из аккаунта: `tailchat --cloud-logout`.

Браузер:

```
https://repentandliveholy.org/tailchat/
```

Логин и пароль те же, что в терминале — это один и тот же аккаунт. Браузер и
терминал видят друг друга в списке пользователей и переписываются между собой.

И ещё раз: всё вышеописанное — необязательная надстройка. `tailchat` без `--cloud`
не обращается к этому серверу ни одним запросом.
