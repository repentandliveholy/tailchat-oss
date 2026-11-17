# Tailchat Development & Architecture Rules

This file defines mandatory guidelines and critical lessons learned for all AI coding assistants working on the Tailchat codebase.

---

## 1. Terminal Keyboard Input & Keypress Deduplication

### Issue: Duplicate Keypresses (`r` -> `rr`, `rrppmm4422`)
- **Root cause:** In Node.js, `node:readline` (`createInterface` or `emitKeypressEvents`) attaches an `onData` listener on `process.stdin`. When `blessed.screen` initializes, `blessed/lib/keys.js` attaches its own decoder. Having two decoders active at the same time causes every typed character to emit two `keypress` events.
- **Rule:**
  - `src/wide-chars.js` must ALWAYS be imported before any Blessed / Readline operations.
  - `src/wide-chars.js` automatically purges lingering `readline` listeners before Blessed starts (`cleanupStreamKeypress`).
  - Never attach a secondary raw `data` listener to parse standard keystrokes on an input stream that Blessed or Readline is already reading.
  - Test with `test/wide-chars.test.js`.

---

## 2. Menu Navigation & Arrow Key Handling

### Issue: Cursor Skipping / Double Jumping on Arrow Keys
- **Root cause:** In `src/menu.js` (`runListMenu`), registering both `screen.program.on('keypress')` and `input.on('data')` causes every arrow key sequence (e.g. Down arrow: `\x1b[B`) to be processed twice — once by `keypress` and once by `data`. This moves the cursor 2 positions per keypress (skipping every other item).
- **Rule:**
  - In `runListMenu` and all blessed-based pickers, NEVER listen to both `screen.program.on('keypress')` and `input.on('data')` for key navigation.
  - Rely exclusively on Blessed's `screen.program.on('keypress')` (or `composer.on('keypress')`).
  - Test with `test/menu.test.js`.

---

## 3. Test Enforcement on Input Changes

Whenever modifying keyboard handling, menus, prompts, or screen lifecycle:
1. Always run `node --test test/wide-chars.test.js test/menu.test.js`.
2. Ensure 1 keypress = 1 logical action under all combinations (Readline -> Blessed Screen 1 -> Screen 2).

---

## 4. WebSocket Packet Sync & No Ping-Pong Loops

### Issue: Rate Limiting ("Too fast. Please slow down.") and Infinite Loops
- **Root cause:** Responding to control frames (like `{ t: 'hello' }`) with another `{ t: 'hello' }`, or broadcasting control frames across multiple sessions of the same user in `src/cloud/hub.js`, creates an infinite feedback loop.
- **Rule:**
  - In `web/cloud/app.js` and CLI, only send `hello` upon initial peer subscription (`subscribed`), NEVER in response to incoming `hello`.
  - In `src/cloud/hub.js`, multi-session broadcast (`self: true`) must ONLY sync actual user chat messages (`msg`, `ai`), NEVER control frames (`hello`, `ping`, `read`, `ack`, `typing`).

---

## 5. Roster Sorting Stability

### Issue: Users jumping / swapping places in roster
- **Root cause:** Sorting by fine-grained `lastSeen` timestamps causes entries to swap places whenever a presence or heartbeat event occurs.
- **Rule:**
  - In `compareUsers`, online users are grouped together and sorted alphabetically by name/login.
  - Offline users are sorted by `lastSeen` only with a threshold (e.g. > 1 minute difference), with alphabetical name as deterministic tie-breaker.


---

## 6. Production Deploy

- Deploy specifics of the reference server (host alias, addresses, keys) live
  in an untracked `AGENTS.local.md` next to this file, not in the repository.
- The server half is `node bin/production-deploy.js`, run on the server from
  the checkout PM2 uses: it fetches `origin/main`, resets to it, rebuilds
  `web/cloud/tailchat.tar.gz` and restarts only the PM2 apps whose tracked
  paths changed. The laptop half is `node bin/release-cloud.js`; the browser
  core (`web/cloud/core/pkg/`, wasm) is built on the laptop only.
- See `docs/cloud-deploy.md` for the deploy/rollback contract and
  `docs/release-checklist.md` for the release runbook.

## 7. `package.json` Version Bumps Must Sync Web Cache-Busters

### Issue: Web fixes silently never reach users after a version bump + deploy
- **Root cause:** `web/cloud/index.html` pins `app.css`/`app.js` with a
  `?v=<version>` query string, and `web/cloud/sw.js` lists the same two
  `?v=<version>` URLs in `SHELL_ASSETS` plus a separately hand-incremented
  `CACHE_NAME` (`tailchat-cloud-vN`). None of these three are derived from
  `package.json` automatically. Bump the version there alone and the Service
  Worker keeps serving the previously cached bundle to every returning PWA
  user forever — the deploy "succeeds" and nothing changes for anyone already
  installed.
- **Rule:**
  - Every `package.json` version bump touching `web/cloud/*` MUST also
    update, in the same commit: `web/cloud/index.html`'s two `?v=` query
    strings, `web/cloud/sw.js`'s two matching `?v=` entries in
    `SHELL_ASSETS`, increment `CACHE_NAME` by one, AND update the pinned
    `tailchat-cloud-vN` literal in `test/cloud-sw.test.js` to match — four
    edits, not three.
  - `test/cloud-sw.test.js` (`PWA release markers … match the package
    version`) enforces the `?v=` half against `pkg.version` automatically —
    it will fail if index.html/sw.js drift from package.json. `CACHE_NAME`
    is not derived from `pkg.version`, but the same test also asserts the
    exact literal it expects `install` to open — miss it and the test run
    (not just a code read) is what catches the drift, so budget for it.

---

## 8. Deploy Immediately After Big Changes

### Issue: fixes that are committed but not deployed do not exist for anyone
- **Root cause:** the app on people's phones is whatever was last published,
  not what is in `main`. A round can be "done" by every other measure —
  committed, tested, version bumped — and change nothing for a single user
  until `production-deploy.js`/`release-android.js` have run. The failures
  this bites hardest are exactly the user-reported ones: a crash they still
  see, or a server storm that keeps repeating because the fixed client is not
  the one on their phone.
- **Rule:**
  - A change that fixes a user-visible defect — a crash, a disconnect, a
    stuck queue — MUST be deployed in the same session, right after the tests
    and the version bump, without waiting to be asked.
  - Cloud and Android go out together when both changed: the release is one
    event for the people using it, and the APK's update popup points at a build
    published in the same step. Publish with
    `node bin/release-cloud.js` (from the laptop: fetch → push → deploy →
    verification, see §6) and then `node bin/release-android.js`; never leave
    one half behind. The manual equivalent is
    `ssh ovh 'cd /opt/tailchat && node bin/production-deploy.js'` — on the box,
    never from the laptop.
  - `git push origin main` comes first: `production-deploy.js` resets the box
    to `origin/main`, so an unpushed commit is a deploy that ships nothing.
  - Verify after, and record the result in `android/HANDOFF.md` +
    `docs/worklog.md`: `/health` is `{"ok":true,…}`, the cache-busted
    `app.js?v=<version>` is served (200), the published APK's SHA-256 matches
    the local one and `aapt2` reports the new `versionCode`, and — because
    releases ship silently (§9) — no `release-<version>` message appeared in
    anybody's conversation with the `tailchat` account while `announcedVersion`
    in the production `accounts.json` stayed where it was.
  - Small, non-user-facing changes (docs, tests, refactors with no behaviour
    change) may be batched; the rule is about fixes people are waiting for.

---

## 9. Releases Are Silent — Nobody Gets a Message

### Issue: a routine deploy wrote into everybody's conversation list
- **Root cause:** `src/cloud/server.js` announced the cloud `VERSION` from the
  `tailchat` service account on **every boot** (`announceCurrentRelease`) and
  again for every new registration (`handleRegister`). Sixteen real people got
  a `release-<version>` message for each version bump — including bumps whose
  only change was inside the CLI.
- **Rule (owner policy, in force until the owner lifts it):**
  - `RELEASE_ANNOUNCEMENTS` in `src/cloud/service-account.js` is `false`, and
    both broadcast paths in `src/cloud/server.js` are gated on it. Keep it
    `false`; a release that sends nothing is not a bug to fix, and a missing
    `announcedVersion` bump is the expected state, not a failed rollout.
  - A cloud, web or CLI release writes **no messages at all**: nothing to the
    `tailchat` account's conversations, no push, no web update popup (that
    popup is fed by these messages, so it goes quiet with them). CLI releases
    ride the cloud version — there is nothing separate to announce.
  - Do **not** add sections to `docs/announcements.md` for a release, and do
    not "announce it quietly" by other means. Nothing reads that file while the
    broadcasts are off.
  - An APK release is the only release that announces itself, and only inside
    the Android client: the update popup driven by
    `web/cloud/android-version.json` (`AppUpdateApi.fetchLatest` →
    `CloudState.updateAvailable`). Never a chat message, never a push, never a
    web popup.
  - The contacts themselves are **not** part of the policy. `tailchat` and
    `tailik` MUST stay in every roster — `linkServiceAccountToEveryone` /
    `linkAiAccountToEveryone` at boot, `linkServiceAccount` / `linkAiAccount`
    on registration. Removing the messages must never remove the contacts;
    `test/cloud-server.test.js` (register/login/users lifecycle) pins both
    halves: the official contact is present, and the only thing in its thread
    is the registration menu.
  - **The menu is not a release.** Registration writes `{tailchat}`'s own menu
    into a brand-new account's thread — `welcome()` in `src/cloud/service-bot.js`,
    delivered from `handleRegister` only while that thread is still empty, under
    the fixed id `service-menu-v1`. That is the account's one unasked-for
    message and it does not reopen anything above: it names no version, it is
    written once per account, and the alternative the owner rejected was a
    conversation with no message, no button and no way to reach the menu.
    Everything else in that thread still answers something the person did, and
    a client shows the menu itself as a button while the thread is empty.
  - Internal records stay: `docs/worklog.md`, `android/HANDOFF.md` and the
    Telegram deploy notification are for the owner, not for users.
  - Reviving the notes is one line — `RELEASE_ANNOUNCEMENTS = true`, which also
    puts `docs/announcements.md` back in charge of their text. Ask the owner
    first; NEVER flip it because a release "looks unannounced".
  - **The one exception, narrowed by the owner on 2026-09-28: the build note.**
    A client that reports the build it is running — `appVersion`, the APK's
    `versionCode`, sent in `auth` — is written exactly one message about *that*
    build, in its own thread with `{tailchat}`, when `docs/android-notes.md`
    carries a section for it (`announceAppBuild` in `src/cloud/service-account.js`).
    Правило владельца: сообщение должно содержать **все главные изменения всех
    коммитов после последней сборки APK** — в понятном и читаемом для пользователя
    виде, без технических деталей и ничего лишнего. И сообщение аккаунта
    `{tailchat}` **обязательно должно быть НЕпрочитанным** (сервер доставляет его
    до `ready`, чтобы `usersFor(conn)` отдавал `pending: 1` в ростер сразу).
    Idempotent on the message id `android-<build>`, so a reinstall, a re-login
    or a reconnect repeats nothing; a build without a section writes nothing at
    all, and `bin/release-android.js` warns when the build it is publishing has
    none. This is not the broadcast coming back: nobody hears about a build
    they are not running, `RELEASE_ANNOUNCEMENTS` stays `false`, and
    `docs/announcements.md` stays frozen.

---

## 10. Menu/List Items Are Styled as a Group, Never One-Off

### Issue: a single reminder icon stood out against five icon-less menu rows
- **Root cause:** `web/cloud/app.js`'s message context menu (`openMessageMenu`)
  renders every item as a plain text `.msg-menu-item` button — Reply, React,
  Forward, Edit, Copy, Delete, all bare text. The reminder entry alone carried
  a `⏰` glyph baked into its i18n string (`msgRemind: '⏰ …'`), because the
  emoji looked nice on its own without checking what the row would sit next
  to. The result was not "a helpful icon" — it was one row visually shouting
  next to five that don't.
- **Rule:**
  - Before adding an icon, badge, colour, or any other decoration to one item
    in a menu, list, or row group, check every sibling item first. If they
    have none, the new item gets none either — text-only menus stay
    text-only, all-icon menus (Android's `MessageAction`/`DropdownMenuItem`,
    which always passes an `icon:`) stay all-icon. A single inconsistent
    element is a bug, not a feature, even when it is "just an emoji."
  - This applies across the whole surface a user reads as one group: a
    dropdown's rows, a settings section's toggles, a roster row's badges — not
    just this specific menu.
  - Fixing a one-off: either remove the decoration (make it match its
    siblings) or add the same decoration to every sibling — never leave it on
    exactly one row while the question is unresolved.

---

## 11. A Form Change Is Comprehensive — Every Client That Draws It, Same Round

### Issue: one line, three clients, three shapes
- **Root cause:** the presence line is the same three parts everywhere — a
  login, a lamp, a word — but each client builds it in its own file
  (`CloudScreen.kt`'s roster header and `CompactBar` subtitle,
  `web/cloud/app.js`'s `updatePeerHeader`, `src/ui.js`'s header) and each was
  tuned alone. The Android roster header spelled out the dot of the
  conversation's own subtitle (`@login ·`) *and* held a lamp in a 20dp box
  around an 8dp ring, so the visible gaps around it came out 12dp and 8dp
  where a conversation's own line sits at one space. The receipt marks drifted
  the same way: web wrote both as `0.82em`, but of two different lines
  (`--text-xs` 11.52px in the roster, the bubble's meta 10.56px in a
  conversation), so the roster's pair drew a size larger than a bubble's.
  Owner: «@godsheep . () online слишком много пробелов … в ростере галочки
  тоже нужно меньше как и в беседах … пометь что везде подход КОМПЛЕКСНЫЙ
  (это касается всего проекта Tailchat)».
- **Rule:**
  - A change to something a person reads as one thing — a presence line, a
    receipt mark, a badge, a menu row — lands in **every client that draws
    it, in the same round**: `web/cloud/app.js` + `app.css`, Android's
    `CloudScreen.kt`, and the terminal's `src/ui.js`. Fixing one client and
    leaving the others is how the drift started; the owner's word for the
    opposite is «комплексный».
  - **The lamp is the separator:** `@login ● online` — login, lamp, word, one
    space each side. Nothing also spells `·` in front of a lamp. The dot
    survives only where there is no lamp to do the job (a service account's
    word, which is not a presence at all).
  - **A mark's size lives in one place per client and is shared by
    construction** — one `--receipt-size` token for the roster's mark *and*
    the bubble's in web, one `RECEIPT_SIZE` + face in the APK — never the
    same fraction taken from two different line sizes, and never one face in
    the roster and another in a bubble.
  - If a client has **no** such surface, say so in the worklog entry instead
    of inventing one: «комплексный» means everywhere the surface exists (the
    terminal has no `@login` presence line, so there is nothing to change
    there), not a new one made to match.

---

## 12. Receipt Marks Are One Ladder — Queued, Sent, Delivered, Read

### Issue: a voice note the peer had read kept showing one tick
- **Root cause:** the single ✓ was doing two jobs at once. `ack` (the peer's
  *device* stored the message) and the server's own commit were both drawn as
  ✓, so a mark could only ever say "somewhere between sent and not read yet",
  and the only way to learn that the peer's phone had the message was to wait
  for the read mark. `deliveredTs` did not exist anywhere: the read watermark
  (`state.reads`, `peerReadTs`) was the only durable proof a mark had, in
  `/api/history`, in the feed and in Room. Owner: «отправляю голосовое — одна
  галочка даже если прочитано … 1 галочка - отправлено? 2 - галочки -
  доставлено на другое устройство - зеленый цвет - прочитано? так? если так то
  так и реализуй».
- **Rule:**
  - One ladder, exactly this, in every client that draws a mark: **⧗** queued
    (never left this device) · **✓** sent (the server committed it) · **✓✓**
    delivered (the peer's *device* holds it) · **✓✓ in the read colour** = read
    · **⚠** failed. Read wins over delivered, delivered over sent, and a mark
    never walks backwards. `⧗`/`⚠` keep their own existing rules.
  - The two doubled ticks are told apart by **colour alone**, so that colour is
    one token per client and the shared one: web's `--signal`, Android's
    `primary`/`signal`, the terminal's `green`; sent and delivered are the
    quiet colour. Never a third glyph and never a different face.
  - **"Delivered" is durable, or it is not a rung.** A mark that reads ✓✓
    before a reload and ✓ after it is worse than no rung at all, so the server
    keeps a per-conversation delivered watermark beside the read one
    (`state.deliveries`, raised by an `ack`, carried as `deliveredTs` on the
    relayed frame and answered as `peerDeliveredTs` by `/api/history`), and
    every client applies it by timestamp exactly as it applies `readTs`.
    Reading implies delivery: any read advance raises it to the same number.
  - **A receipt is never dropped.** A client that cannot hand a read receipt to
    the socket keeps it queued and retries, and never clears its own unread
    bookkeeping before the frame has actually left — a read that never reaches
    the server leaves the other side's mark on ✓ forever, which is the whole
    complaint this rule exists for. Android already keeps the row unread until
    `read-accepted`; web keeps the queued receipt until `sendFrame` returns.
  - **Control frames ride the relay.** `read`/`ack` are the server's
    bookkeeping — its watermark is what the peer's marks are rebuilt from — so
    they must never take a peer-to-peer shortcut (`sendFrame`'s WebRTC data
    channel), which would leave the server and every other device of the
    author's account behind.
  - The ladder lands in **every client that draws it, in the same round** — web,
    APK and terminal — on §11's terms.

---

## 13. Любое изменение проверяется на регресс в остальной части приложения

### Issue: правка проверена там, где её сделали, и ломает в другом месте
- **Root cause:** «готово» проверялось только на той поверхности, ради которой
  правку делали. В этом репозитории почти всё, что меняют, читает не один
  потребитель: `--receipt-size`/`RECEIPT_SIZE` — одно число на четыре
  поверхности (мета бабла и превью ростера в вебе, те же две в APK); ватермарка
  `read`/`ack` — то, из чего метки восстанавливаются в `/api/history`, в фиде и
  в Room (§12); `?v=` в `package.json` — то, от чего зависит, доедет ли бандл до
  установленной PWA (§7); `user-select` в режиме выбора — выделение текста во
  всём транскрипте; `receiptGlyph` в `ChatScreen.kt` — отдельный экран APK со
  своим размером, который с меткой облака не связан и потому легко забыть.
  Классический провал такого рода — проверка, которая «не может упасть»:
  §9-проба два релиза подряд отвечала «тихо», разбирая AEAD-конверт вместо стора.
- **Rule:**
  - Перед правкой **перечислить всех потребителей** изменяемого — `xd://lsp`
    references или `grep`: другие клиенты (`web/cloud/app.js` + `app.css`,
    `src/ui.js`, `CloudScreen.kt`), другие экраны, серверные производные
    (история, фид, Room, `sw.js`-кэш, `accounts.json`) и сохранённые данные.
    Список — часть задачи, а не побочный результат.
  - Проверка обязана **исполнить каждую из этих поверхностей**, а не только путь
    правки: живой клиент, реальный рендер, настоящий кадр — юнит-тест
    изменённого модуля не заменяет ни одной из них (§5).
  - Если потребитель намеренно остаётся прежним (P2P-лестница APK
    Sent/Acked/Read, текстовая форма меток в терминале), это
    **пишется в worklog как решение** — «не тронуто намеренно, потому что…».
    Молчание об этом и есть та ошибка, от которой защищает пункт.
  - В worklog идёт радиус проверки целиком: что запускали (`node --test`,
    `./gradlew`, живой браузер/эмулятор), на какой ревизии и что именно видели.
  - Это поведенческая половина §11: §11 — про одинаковый **вид** одной вещи во
    всех клиентах, §13 — про то, что правка в одной части приложения не ломает
    **поведение** в другой.

