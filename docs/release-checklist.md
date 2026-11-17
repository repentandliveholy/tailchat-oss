# Чек-лист проверки и релиза Tailchat

Для владельца: как самому прогнать проверку и выпуск, без агента.
Новые записи в `docs/worklog.md` делает владелец или агент по этой же схеме —
команды ниже только про проверку, публикацию и записи.

Все команды — **однострочные**. `\` в конце строки не использовать: вставка
через Warp склеивает продолжения в один аргумент, и `node --test` получает
единственный «файл» вида `test/a.test.js, test/b.test.js` («Could not find …»).

## 0. Что где лежит

| Что | Значение |
| --- | --- |
| Репозиторий | `~/tailchat`, ветка `main` |
| Прод-хост | `ssh ovh` (alias из `~/.ssh/config`); публичный IP/домен для SSH **не** работают |
| Прод-код | `/opt/tailchat`, PM2-приложения `tailchat-cloud` (7683) и `tailchat-gateway` (7681) |
| Данные облака | `/var/lib/tailchat-cloud/accounts.json` |
| `adb` | не в `PATH`; полный путь `~/Library/Android/sdk/platform-tools/adb` |
| `aapt2` | `~/Library/Android/sdk/build-tools/37.0.0/aapt2` |
| Версия облака | `package.json` → `version` (сейчас `1.92`) |
| Версия APK | `android/app/build.gradle.kts` → `versionCode` / `versionName` (сейчас `144` / `0.76.39`) |

Версии руками не вписывать — брать из файлов, иначе легко проверять старое.

## 1. Тесты

```sh
cd ~/tailchat
node --test
```

Весь набор целиком: сейчас 1314 тестов, 1311 pass, 3 skipped, ~43 с. Падение —
ненулевой код возврата, строка `ℹ fail N`.

Только затронутое (одна строка, без `\`):

```sh
node --test test/cloud-hub.test.js test/cloud-accounts.test.js test/cloud-fcm.test.js test/cli.test.js test/web-unread-watermark.test.js test/reminders.test.js test/reminder-core.test.js
```

Сейчас это 309 тестов, 0 падений, ~6 с.

Android-юниты:

```sh
cd ~/tailchat/android && ./gradlew testDebugUnitTest
```

Сейчас 324 теста в 48 классах, 0 падений, ~30 с.

**Грабли.** Если вывод — `30 actionable tasks: 30 up-to-date` и `BUILD SUCCESSFUL
in 1s`, тесты **не запускались**: Gradle считает задачу актуальной. Форсировать:

```sh
cd ~/tailchat/android && ./gradlew cleanTestDebugUnitTest testDebugUnitTest
```

Сводка по XML-отчётам (без Gradle-вывода):

```sh
python3 -c "import glob,xml.etree.ElementTree as E;r=[E.parse(p).getroot() for p in glob.glob('android/app/build/test-results/testDebugUnitTest/*.xml')];print('tests',sum(int(x.get('tests',0)) for x in r),'failures',sum(int(x.get('failures',0)) for x in r),'errors',sum(int(x.get('errors',0)) for x in r))"
```

## 2. Сборка клиентов

```sh
cd ~/tailchat/android && ./gradlew assembleDebug assembleRelease
```

У веба шага сборки нет: `web/cloud/tailchat.tar.gz` (бандл CLI для скачивания)
собирает на боксе `bin/production-deploy.js` из точного коммита.

## 3. Проверка прода (только чтение)

```sh
cd ~/tailchat
VER=$(node -p "require('./package.json').version")
ssh ovh 'curl -s localhost:7683/health'
curl -s -o /dev/null -w '%{http_code}\n' "https://repentandliveholy.org/tailchat/app.js?v=$VER"
```

Ожидание: `{"ok":true,"aiBridge":true}` и `200`.

Логи службы (и разбор строки `cloud: read` — «кто отметил прочитанным») —
`docs/cloud-logs.md`.

**Грабли.** URL подставлять целиком. Многоточие из переписки (`.../tailchat/app.js?v=1.92`)
— это не адрес: `curl: (2) no URL specified`. В двойных кавычках переменные
раскрываются, в одинарных — нет.

APK: скачать публичный файл, сверить sha256 и versionCode, сверить манифест.

```sh
cd ~/tailchat
curl -s -o /tmp/tc.apk https://repentandliveholy.org/tailchat/tailchat.apk
shasum -a 256 /tmp/tc.apk web/cloud/tailchat.apk android/app/build/outputs/apk/release/app-release.apk
~/Library/Android/sdk/build-tools/37.0.0/aapt2 dump badging /tmp/tc.apk | head -3
curl -s https://repentandliveholy.org/tailchat/android-version.json
```

Ожидание: три одинаковых sha256; `versionCode='144' versionName='0.76.39'`;
в манифесте тот же `sha256` и те же `versionCode`/`versionName`.

Какой коммит реально лежит на боксе:

```sh
ssh ovh 'cd /opt/tailchat && git rev-parse --short HEAD'
```

### Тишина (§9 AGENTS.md)

Релиз не должен писать людям ни одного сообщения, и это проверяется
автоматически: `node bin/release-cloud.js --check` снимает снимок стора до и после
и сравнивает `announcedVersion`, список `release-<версия>` и число текстов со
словом «release». Ожидаемая строка — `ok silence: announcedVersion=1.68 unchanged,
no message for <версия>`.

Проба читает хранилище **тем же модулем, что и облако** (`readyCipher` +
`readCloudSidecar`, ключ `TAILCHAT_CLOUD_MASTER_KEY_FILE`, по умолчанию
`/etc/tailchat-cloud/master.key`): с 24.09 `accounts.json` — AEAD-конверт
(`{"format":"tailchat-cloud-aead",…}`), и разбор его как обычного JSON ничего не
проверял — ключа `history` в конверте нет, поэтому «тишина» выводилась при любом
содержимом. Три нужных значения вынимаются из расшифрованного текста по образцу,
**без `JSON.parse`**: снимок — ~186 МБ, и объектный граф из него на боксе, который
этим же стором и работает, это гигабайт памяти за три скаляра
(`silenceProbeScript` в `src/release-cloud.js`, тест — `test/release-cloud.test.js`).

Посмотреть те же три числа руками (тем же кодом, чтобы не расходиться с проверкой):

```sh
cd ~/tailchat
node --input-type=module -e "import {silenceProbe} from './src/release-cloud.js';console.log(JSON.stringify(silenceProbe({host:'ovh'}),null,1))"
```

Ожидание: `announcedVersion: "1.68"` и `releaseIds` — только эпоха `release-1.13…1.68`.
`announcedVersion` в проде стоит на `1.68` и **не должен** двигаться: это признак
того, что рассылка выключена, а не что релиз не вышел. Новый `release-<версия>` или
выросший `releaseTexts` — регресс, идти в `src/cloud/service-account.js`
(`RELEASE_ANNOUNCEMENTS`). Недоступная проба (нет ключа, файл не расшифровался)
даёт `silence-probe-unavailable`: проверка падает громко, а не молчит.

Отдельно от рассылки — сообщение о сборке (§9, исключение 2026-09-28): после
публикации APK у тех, кто на неё перешёл, в треде с `{tailchat}` должен
появиться ровно один `android-<versionCode>`; у остальных — ни одного. Это не
регресс и не повод двигать `announcedVersion`:

Хранилище читается тем же модулем, что и у облака (оно зашифровано — см.
предупреждение выше). Это разовый ручной разбор и он строит объектный граф всего
снимка — на боксе с ~8 ГБ свободной памяти это проходит, но не запускайте его
пачкой:

```sh
ssh ovh 'cd /opt/tailchat && TAILCHAT_CLOUD_MASTER_KEY_FILE=/etc/tailchat-cloud/master.key node --input-type=module -e "import {readCloudSidecar} from \"./src/cloud/storage-crypto.js\";const d=JSON.parse(readCloudSidecar(\"/var/lib/tailchat-cloud\",\"accounts.json\"));const out=[];for(const k in (d.history||{}))for(const m of (d.history[k]||[]))if(typeof m.id===\"string\"&&m.id.startsWith(\"android-\"))out.push(m.id+\" \"+k);console.log(out.join(\"\\n\")||\"(none yet)\")"'
```

## 4. Публикация Android

Перед запуском — при необходимости поднять `versionCode`/`versionName` в
`android/app/build.gradle.kts` (скрипт сам их не меняет, только читает) и
дописать раздел для нового `versionCode` в `docs/android-notes.md`: это то
единственное, что человек узнаёт о сборке, которую поставил (одно сообщение от
`{tailchat}` в его собственном треде, только тому, кто на этой сборке, — §9
AGENTS.md). Раздел должен содержать **все главные изменения всех коммитов после
последней сборки APK** — в читаемом виде, без лишних технических подробностей.
Сообщение приходит пользователю **НЕпрочитанным** (бейдж в ростере).
Раздела нет — сообщения не будет, и скрипт про это предупредит
строкой `No section for build N …`, но публикацию не остановит.

Одна команда: сборка, копирование, повторное скачивание публичного URL со
сверкой хэша, публикация `android-version.json`, отправка в Telegram.

```sh
cd ~/tailchat && node bin/release-android.js
```

Без Telegram-сообщения (например, при повторной публикации того же билда):

```sh
cd ~/tailchat && node bin/release-android.js --no-telegram
```

Скрипт сам падает, если публичный URL отдаёт другие байты — «скачалось, но не
то» он не пропустит. `web/cloud/tailchat.apk` и `web/cloud/android-version.json`
в `.gitignore`, коммитить после публикации нечего.

## 5. Деплой облака и веба

### Какой скрипт где запускать

| Скрипт | Где | Что делает |
| --- | --- | --- |
| `node bin/release-cloud.js` | ноутбук | сборка ядра для веба → push → удалённый деплой → доставка ядра → проверка публичного фронта и тишины |
| `ssh ovh 'cd /opt/tailchat && node bin/production-deploy.js'` | бокс | reset на `origin/main`, `npm ci`, перезапуск только затронутых PM2-приложений, откат, отчёт в Telegram |
| `node bin/release-android.js` | ноутбук | сборка APK → публикация → сверка скачанного файла → Telegram |
| `npm run deploy` | **только бокс** | то же, что `production-deploy.js` |

Перепутать половины безопасно, но бессмысленно, и оба скрипта это говорят сами:
`production-deploy.js` на ноутбуке падает на проверке Caddy
(`external-config-unreadable`, exit 1) до любых изменений — он не найдёт
`/etc/caddy/Caddyfile`; а `release-cloud.js` на боксе отказывается работать сразу
(`/opt/tailchat is the production checkout`), потому что `git push` и `ssh ovh`
оттуда — это команды в никуда.

### Как пользоваться

```sh
cd ~/tailchat && node bin/release-cloud.js
```

Порядок шагов и то, что видно на каждом:

1. `git fetch origin main` — иначе «впереди или позади» отвечает устаревшая ссылка.
2. Гейты, до которых ничего не меняется: изменённые tracked-файлы, ветка не `main`,
   отставание от `origin/main`.
3. `node bin/build-web-core.js` — ядро для браузера (этап 7) в `web/cloud/core/pkg/`.
   Собирается **здесь, на ноутбуке**, и только здесь: на боксе нет Rust и не будет
   (решение владельца 2026-11-11). Нужны `rustup target add wasm32-unknown-unknown` и
   `wasm-bindgen-cli` той версии, что в `crates/Cargo.lock` (скрипт сам скажет, какой).
   Ошибка сборки останавливает релиз до push — нигде ничего не изменилось.
4. `git push origin main`.
5. `ssh ovh 'cd /opt/tailchat && node bin/production-deploy.js'` — вывод идёт насквозь,
   код возврата решает судьбу релиза.
6. Доставка ядра: `tar` двух файлов pkg прямо в stdin `ssh ovh`, распаковка в
   `web/cloud/core/.pkg-next`, подмена `pkg`, `sha256sum` с бокса сверяется с локальным.
   Идёт **после** успешного деплоя: откатившийся деплой не получит новое ядро к старой
   странице. Перезапуск не нужен — сервер перечитывает файл по mtime/размеру, а ядро
   отдаётся `no-store`, поэтому и `?v=` ему не нужен. `pkg/` в `.gitignore`, и
   `git reset --hard` следующего деплоя его не трогает.
7. Семь проверок публичного фронта и одна про тишину (см. ниже); любая неудача —
   exit 1 и строка `RELEASE NOT VERIFIED`.

Флаги:

| Флаг | Что делает |
| --- | --- |
| `--check` | только проверка, ничего не пишет: ни push, ни деплой, ни ssh-мутаций |
| `--dry-run` | печатает план и выходит |
| `--host ovh` | другой SSH-хост из `~/.ssh/config` |
| `--base https://…` | другой публичный адрес |

Имена проверок в отчёте:

| Проверка | Что означает FAIL |
| --- | --- |
| `remote-health` | `curl localhost:7683/health` на боксе не отдал `{"ok":true,…}`: смотреть `pm2 logs tailchat-cloud` |
| `remote-rev` | HEAD в `/opt/tailchat` не тот, что локально: на боксе другой коммит, деплой не доехал. В `--check` отставание на свои же коммиты (docs, тесты) допускается — в строке видно `N commit(s) behind local HEAD, not deployed yet`; не допускается коммит, которого в этой истории нет, или более новый, чем локальный |
| `served-index` | отданный `index.html` не ссылается на `?v=<version>`: забыта правка кеш-бастера (§7) или отдаётся старый файл |
| `served-app`, `served-css` | ассет по `?v=<version>` не отвечает 200 |
| `served-sw` | `sw.js` держит другой `?v=` в `SHELL_ASSETS` — PWA отдаст старый бандл |
| `served-core` | `core/pkg/tailchat_web_bg.wasm` или `tailchat_web.js` не отвечает 200, wasm отдан не как `application/wasm` или это не WebAssembly; в полном релизе — ещё и байты не совпали с только что собранными. В `--check` сравнивать не с чем (локальный pkg может быть сборкой для разработки), поэтому там только «отдаётся и это wasm». FAIL здесь значит, что `?core=1` у людей откатывается на классический веб |
| `silence` | §9: сдвинулся `announcedVersion` или появилось новое `release-*` |

Что делать при отказе: `dirty-checkout` — закоммитить или убрать правки, деплой
выкатил бы не то, что проверено; `not-main` — переключиться на `main`; `behind-origin` —
`git pull --ff-only` (бокс выкатил бы коммит, которого здесь никто не проверял);
`push завершился с кодом N` — разобраться с remote до деплоя; деплой упал — смотреть
его вывод и Telegram: откат уже выполнен самим скриптом.

Проверка без публикации — то, чем стоит заканчивать любой деплой руками:

```sh
cd ~/tailchat && node bin/release-cloud.js --check
```

Ручной вариант, если скрипт недоступен: сначала push, потом деплой.

```sh
cd ~/tailchat && git push origin main
ssh ovh 'cd /opt/tailchat && node bin/production-deploy.js'
```

**Если менялся `package.json`** — в том же коммите синхронизировать
кеш-бастеры (§7 AGENTS.md): две строки `?v=` в `web/cloud/index.html`, две в
`web/cloud/sw.js`, `CACHE_NAME` (`+1`) и литерал `tailchat-cloud-vN` в
`test/cloud-sw.test.js`. Четыре правки; `test/cloud-sw.test.js` ловит
расхождение `?v=` с `package.json`. Проверка после деплоя ловит обратное:
если на боксе остался старый `?v=`, релиз объявляется непроверенным.

Запись только в `docs/` и `android/HANDOFF.md` повторного деплоя не требует —
рантайм не меняется: `selectProductionApps` для таких путей возвращает пустой
список, перезапускать нечего.

## 6. Записи после релиза

В `docs/worklog.md` — новая запись сверху, в формате
**Запрос → Диагноз → Решение → Изменения → Проверка → Релиз → Осталось**
(ссылки на строки — на состояние после правки). В `android/HANDOFF.md` — что
сделано, чем подтверждено, что осталось.

```sh
cd ~/tailchat && git add docs/worklog.md android/HANDOFF.md
cd ~/tailchat && git commit -m "Record Android 0.76.39 release"
cd ~/tailchat && git push origin main
```

**Грабли.** В корне лежат untracked `HANDOFF.md`, `HANDOFF_2026-09-21.md`,
`HANDOFF_LOGO.md`, `HANDOFF_WALLPAPERS.md`, `SESSION_HANDOFF.md` — чужие файлы
прошлых сессий. `git add -A` затянет их в коммит; добавлять только явные пути.

## 7. Проверка на телефоне

```sh
ADB=~/Library/Android/sdk/platform-tools/adb
$ADB devices -l
$ADB install -r ~/tailchat/web/cloud/tailchat.apk
$ADB shell monkey -p net.tailchat.android -c android.intent.category.LAUNCHER 1
$ADB logcat -s TailchatCloud:D ChatService:D CallController:D
```

Логи у приложения идут под тегами `TailchatCloud`, `ChatService`,
`CallController`, `CallAudio`, `CallRinger`, `CallService`, `CallEngine`,
`CloudSessionStore`, `WebRtcEngine` — общего тега `Tailchat` нет.

Что смотреть руками:

- **свайп по ростеру (влево).** Открываются три действия: прочитано/непрочитано,
  mute, «ещё». Карточка только смещается (`offset`) — аватар, имя и превью не
  должны перекомпоновываться; вертикальная прокрутка не перехватывается;
  отпускание раньше порога возвращает строку назад;
- **напоминание.** Долгое нажатие на сообщение → «10 мин / 1 ч / вечером /
  завтра». По срабатыванию: системная заметка «Пора ответить …» + уведомление;
  после reconnect напоминание не повторяется (клиент подтверждает его ack'ом);
- **терминал.** `/unread` и `/later last 10m` (пресеты `10m|1h|evening|tomorrow`,
  цель `last` | `1..N` | id сообщения) — те же два действия из CLI.

### Как это повторять без рук (adb)

Состояние экрана читается через accessibility-дерево, а не через скриншот —
это работает и когда у агента нет зрения, и даёт координаты для нажатий:

```sh
ADB=~/Library/Android/sdk/platform-tools/adb
$ADB shell uiautomator dump /sdcard/ui.xml >/dev/null && $ADB shell cat /sdcard/ui.xml
```

**Грабли инъекции жестов** (проверено на RMX3624, API 34, density 320 ≈ 2 px/dp):

- короткий `input swipe` (десятки пикселей, любая длительность) Android читает
  либо как **тап** (открывает диалог), либо как **долгое нажатие** (открывает
  меню строки `Open chat / Block contact / Delete contact`). Порог жеста ростера
  — 36dp, но ход меньше ~80px до него просто не доходит: движение вплотную к
  touch slop фреймворк считает неподвижностью;
- `input motionevent DOWN/MOVE/UP` из отдельных вызовов **одним жестом не
  становится** — каждый вызов это новый процесс, и последовательность снова
  выглядит как удержание;
- рабочий рецепт для свайпа: ход **≥150dp** от начала движения и длительность
  **500–900 мс**: `$ADB shell input swipe 600 700 300 700 500` — раскрывает
  действия строки;
- перед жестом **сверить координаты по свежему дампу**: попадание на соседнюю
  строку выглядит как тап и уводит в другой диалог (именно так «свайп не
  работал», пока не выяснилось, что он приходится на строку Saved messages);
- `input swipe x y x y 900` (нулевой ход, 900 мс) — это долгое нажатие: так
  открывается лист действий сообщения (Reply / Remind to reply in 10 minutes /
  1 hour / this evening / tomorrow / Forward / Copy / Edit / Delete…).

Что не нажимать при смоуке без явной просьбы: `Mute` (меняет настройки
уведомлений владельца), `Delete for me` / `Delete for everyone` (необратимо),
`Block contact`. Пометка `Unread` обратима — снимается первой же прочитанностью.

### Что считать доказательством

- **Свайп не отбирает вертикаль.** Диагональный drag с доминированием вертикали
  (`input swipe 640 800 580 700 400`) должен прокрутить список: строки меняют
  `y`, появляются новые, действий `Unread/Mute/More` в дереве **нет**.
- **Свайп раскрывается за порогом.** `input swipe 600 700 300 700 500` —
  в дереве появляются три действия, заголовок остаётся `Conversations`
  (навигации нет).
- **Пометка непрочитанным.** Тап по `Unread` → в ростере строка показывает
  `1 unread` (поле `pending` из ростера, то есть серверная правда), а в сторе
  появляется `markedUnread`; открытие диалога снимает и бейдж, и запись.
  Снапшот `accounts.json` пишется с задержкой (снапшот дебаунсится), поэтому
  сразу после действия там может быть пусто — читать через ~30 с.
- **Напоминание.** Долгое нажатие на сообщение → «Remind to reply in 10 minutes» →
  в сторе появляется `replyReminders.<логин>` с `dueAt ≈ now + 600 с`; через
  10 минут запись получает `firedAt`, а после подтверждения клиентом исчезает,
  на телефоне — системная заметка и уведомление. Меньшего срока в UI нет, так
  что это единственный сценарий с десятиминутным ожиданием; сам момент
  срабатывания покрыт тестом хаба, а ожидание ускорять нечем.

## 8. Чего не делать

- `pm2 restart all` — никогда; только `production-deploy.js`, он решает по
  изменённым путям. На боксе живут чужие приложения (`tailik`, `gemini_bot`,
  `remindka`, `yt-dlp-tg`, `bgutil-provider`) — их не трогать.
- Не поднимать `RELEASE_ANNOUNCEMENTS` в `src/cloud/service-account.js` и не
  добавлять секции в `docs/announcements.md`: рассылка выключена по решению
  владельца (AGENTS.md §9). Контакты `tailchat`/`tailik` при этом обязаны
  оставаться в ростере у всех.
- Не «анонсировать тихо» другими средствами и не считать отсутствие
  `announcedVersion`-бампа ошибкой.
- Не проверять продовую активность командой `curl /api/login` с реальными
  логинами: лимит 10 неудачных попыток на адрес за 15 минут, и он общий для
  всего деплоя.
