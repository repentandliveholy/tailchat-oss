# План: новые метки доставки + отмена группировки сообщений (web / APK / CLI)

**Статус:** выполнен и выпущен 2026-10-02: cloud/CLI 1.127, APK 0.76.77 / 182.
Код `472a1da`; проверки, кадры и подтверждение тихого релиза — в [worklog](../worklog.md). Активные записи в `AGENTS.md` и `docs/backlog.md` сняты после проверенной публикации.
**Заказ владельца (2026-10-02), дословно:**

> WEB\APK: галочки сделай стандартного размера и не outdated shape как были
> раньше; ровные и для экономии места одна накладываться должна на другую;
> при выделении в APK убери галочки; не нужно соединять сообщения группами,
> убирая время и тд; каждое сообщение отдельно должно быть; подход
> комплексный apk-web и возможно cli.

Три независимые задачи. Делать можно в любом порядке, выпускать — одним
релизом (§8): это видимые дефекты, их ждут на телефоне.

* **A. Форма метки.** Текстовые `✓`/`✓✓` заменяются одной векторной меткой:
  стандартный размер, ровные штрихи, вторая галочка накладывается на первую.
* **B. Выделение в APK.** В режиме выделения сообщений метка доставки не
  рисуется (там уже стоит кружок-галочка выделения — два разных ✓ в одном
  бабле).
* **C. Группировка.** Серии сообщений одного автора больше нет: у каждого
  сообщения свой заголовок автора, своё время и своя метка.

---

## 0. Что сейчас в коде (проверено на `e72958b`, строки на этой ревизии)

### Web
| Что | Где |
|---|---|
| Токен размера метки `--receipt-size: 0.60rem` | `web/cloud/app.css:40-52` |
| `.bubble-mark` (размер, `letter-spacing: -0.06em`, `[data-state="read"]` → `--signal` + `font-weight: 800`) | `web/cloud/app.css:2359-2369` |
| `.roster-mark` (то же самое в строке ростера) | `web/cloud/app.css:764-777` |
| `.bubble-meta` (строка времени, `font-size: 0.66rem`, `height: 1.125rem`) | `web/cloud/app.css:2342-2357` |
| `setMark(mark, state, readAt, readVia)` — **единственная** лестница, пишет `dataset.state` и `textContent` | `web/cloud/app.js:9493-9521` |
| Создание метки у голосового | `web/cloud/app.js:4760-4769` |
| Создание метки у обычного сообщения | `web/cloud/app.js:8746-8752` |
| Метка в превью ростера | `web/cloud/app.js:7218-7240` |
| Группировка серий | `web/cloud/app.js:12159-12187`, вызов из `normalizeDateDividers` — `:12213` |
| CSS-хвост группировки | `web/cloud/app.css:2054-2057` (`.row`, `margin-bottom: 3px`) и `:2068-2070` (`.row.series-end`, `6px`) |
| Режим выделения (только заливка `.row-selected`, своей ✓-плашки нет) | `web/cloud/app.js:9771-9864` |

### APK (cloud-экран)
| Что | Где |
|---|---|
| `RECEIPT_SIZE = 10.sp` | `CloudScreen.kt:2514-2523` |
| `cloudReceiptGlyph(delivery)` — лестница `⧗/✓/✓✓/⚠` | `CloudScreen.kt:2525-2550` |
| `cloudReceiptColor(message)` | `CloudScreen.kt:2552-2558` |
| Метка в бабле (`Text`, `TailchatMono`, `RECEIPT_SIZE`) | `CloudScreen.kt:2863-2873` |
| `rosterPreviewLine(...)` → `RosterPreviewLine.mark: String?` | `CloudScreen.kt:1535-1570` |
| Метка в превью ростера (`Text`, та же гарнитура/размер) | `CloudScreen.kt:1589-1623` |
| Группировка серий (`sameMessageSeries`, `startsSeries`/`endsSeries`, `showAuthor`/`showMeta`, отступ 6/3 dp) | `CloudScreen.kt:2214-2225`, `:2603-2613`, параметры `:2626-2627`, применение `:2767`, `:2812` |
| Кружок-галочка выделения | `CloudScreen.kt:2878-2900` |
| P2P-экран со своей меткой `receiptGlyph` | `ChatScreen.kt:96-100`, `:327-334` |

### CLI
| Что | Где |
|---|---|
| Ранги меток `MARKER_RANK` | `src/ui.js:117-118` |
| Группировка (`sameSeries`, `groupKey`, `draw()`) | `src/ui.js:159-182` |
| `renderMessageMarkup({ showAuthor, showMeta })` | `src/ui.js:1119-1159` |

---

## 1. A — форма метки

### 1.1 Решение

Метка перестаёт быть символом шрифта и становится **вектором одной и той же
геометрии в обоих клиентах**. Причина — именно та, что назвал владелец:
`U+2713` в моношрифте и есть «outdated shape», а две такие подряд нельзя ни
выровнять, ни наложить (можно только зажать `letter-spacing`, что и стоит
сейчас: `-0.06em`).

**Канон геометрии (одна на web и APK, не повторять «на глаз»):**

```
Одна галочка, локальные координаты:  M0 3.4  L2.9 6.3  L8 0
  stroke-width 1.8 · linecap round · linejoin round · fill none

Single:  viewBox "0 0 10 12"    — галочка сдвинута на (1, 2.85):
         M1 6.25 L3.9 9.15 L9 2.85

Double:  viewBox "0 0 14.2 12"  — та же галочка дважды, вторая на +4.2 по X
         (перекрытие 3.8 из 8 ≈ 47 % — это и есть «одна накладывается на
         другую» и экономия ширины против двух раздельных):
         M1   6.25 L3.9 9.15 L9    2.85
         M5.2 6.25 L8.1 9.15 L13.2 2.85
```

Пропорции: single `10:12`, double `14.2:12`. Ширина выводится из высоты:
`w_single = h × 0.833`, `w_double = h × 1.183`.

**Размер («стандартный»):** высота метки `h` = 0.72rem в вебе (11.5 px) и
11.dp в APK вместо нынешних 0.60rem / 10.sp. Это по-прежнему одно число на
клиент (§11: `--receipt-size` / `RECEIPT_SIZE`), просто теперь это высота
штриха, а не кегль шрифта.

**Цвет — единственное, что отличает «доставлено» от «прочитано»** (§12):
вектор заливается `currentColor`, `read` берёт акцент (`--signal` / `primary`),
`sent`/`ack` — цвет строки. Третьего глифа не появляется.

**`⧗` и `⚠` остаются текстом** — они не галочки, их форму владелец не трогал;
их кегль поднимается до того же `h`, чтобы ряд не прыгал. Записать это
решение в worklog (§13).

### 1.2 Web

1. `web/cloud/app.css`: заменить токен `--receipt-size: 0.60rem` на
   `--receipt-size: 0.72rem` (это теперь **высота**) и переписать комментарий
   над ним — он сейчас объясняет долю от кегля меты, которой больше нет.
2. Добавить рядом с токеном две data-URI маски (общий блок, чтобы `.bubble-mark`
   и `.roster-mark` читали одно и то же):

   ```css
   --receipt-single: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 12'><path d='M1 6.25 L3.9 9.15 L9 2.85' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/></svg>");
   --receipt-double: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14.2 12'><path d='M1 6.25 L3.9 9.15 L9 2.85' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/><path d='M5.2 6.25 L8.1 9.15 L13.2 2.85' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/></svg>");
   ```

3. Общее правило для обеих меток (новый блок, на `.bubble-mark, .roster-mark`):

   ```css
   .bubble-mark,
   .roster-mark {
     display: inline-flex;
     align-items: center;
     line-height: 1;
     font-size: var(--receipt-size);   /* только для ⧗ / ⚠ */
   }
   /* Галочки рисуются вектором: текст внутри остаётся как доступное имя и как
      контракт `setMark`, но не занимает места. */
   .bubble-mark[data-state="sent"],  .roster-mark[data-state="sent"],
   .bubble-mark[data-state="ack"],   .roster-mark[data-state="ack"],
   .bubble-mark[data-state="read"],  .roster-mark[data-state="read"] { font-size: 0; }

   .bubble-mark[data-state="sent"]::before, … { мaска --receipt-single,
       width: calc(var(--receipt-size) * 0.833); }
   .bubble-mark[data-state="ack"]::before, …,
   .bubble-mark[data-state="read"]::before, … { маска --receipt-double,
       width: calc(var(--receipt-size) * 1.183); }
   ```

   У `::before`: `content: ''; display: block; height: var(--receipt-size);
   background: currentColor; mask: … center / contain no-repeat;
   -webkit-mask: … center / contain no-repeat;` — префикс обязателен, в PWA
   на iOS без него метка исчезнет совсем.
4. Удалить `letter-spacing: -0.06em` у обеих меток (его роль — наложение —
   теперь в геометрии) и `font-weight: 800` у `[data-state="read"]` (жир к
   вектору не применяется; `[data-state="read"] { color: var(--signal) }`
   остаётся).
5. **`setMark` не трогать по сигнатуре и не делать DOM-зависимым.** Четыре
   теста выдёргивают её регуляркой `function setMark\(mark, state, readAt = 0,
   readVia = ''\)` и исполняют в `vm` на объектах-заглушках `{ dataset,
   textContent }`: `test/web-cross-client-read.test.js:33,459`,
   `test/web-roster-preview-mark.test.js:19`, `test/web-durable-send.test.js:61`,
   `test/web-sync-feed.test.js:54`. Любой `document.createElementNS` внутри —
   мгновенно красные тесты. Отсюда и выбран путь «текст + CSS-маска».

### 1.3 APK

1. Новый файл `android/app/src/main/java/net/tailchat/android/ui/ReceiptMark.kt`:
   * два `ImageVector` по канону §1.1 (`viewportWidth/Height` = `10/12` и
     `14.2/12`, `stroke = SolidColor(Color.Black)` + `tint` на `Icon`,
     `strokeLineWidth = 1.8f`, `StrokeCap.Round`, `StrokeJoin.Round`),
     собранные один раз в `by lazy`/`remember`;
   * `@Composable internal fun CloudReceiptMark(delivery: CloudDelivery, color: Color, modifier: Modifier = Modifier)`:
     `Read`/`Delivered` → двойной вектор, `Accepted` → одинарный,
     `Queued`/`Sending` → `Text("⧗")`, `Failed` → `Text("⚠")` — оба текстовых
     в `TailchatMono` с `fontSize = RECEIPT_SIZE`;
   * высота `Icon` = `RECEIPT_HEIGHT`, ширина = `RECEIPT_HEIGHT * 0.833f` /
     `* 1.183f`.
2. `CloudScreen.kt`: `RECEIPT_SIZE = 10.sp` → `11.sp` (для `⧗`/`⚠`) и рядом
   `internal val RECEIPT_HEIGHT = 11.dp`; переписать комментарий 2514-2522 —
   он объясняет старую пропорцию.
3. Бабл (`:2863-2873`): `Text(cloudReceiptGlyph(...))` → `CloudReceiptMark(
   message.delivery, cloudReceiptColor(message))`.
4. Ростер: `rosterPreviewLine` сейчас считает `CloudDelivery` (`:1555-1560`) и
   тут же схлопывает его в строку. Поменять поле `RosterPreviewLine.mark` на
   `CloudDelivery?` и отдавать рунг; `RosterPreviewText` (`:1589-1623`) рисует
   `CloudReceiptMark`. Выравнивание и «метка не сжимается» (issue #25)
   сохранить: иконка — `Modifier.alignByBaseline()` не поддерживает, поэтому
   держать её в том же `Row` с `verticalAlignment`, как сейчас, и не давать
   ей `weight`.
5. `cloudReceiptGlyph` **остаётся** — это лестница (`CloudReceiptGlyphTest`) и
   источник текста для `⧗`/`⚠`; её поведение не меняется.
6. P2P-экран `ChatScreen.kt:96-100,327-334` рисует свою `receiptGlyph` тем же
   устаревшим символом. Это другой экран того же приложения, и жалоба про
   форму относится и к нему: заменить вывод на `CloudReceiptMark`, сопоставив
   `Receipt.Sent/Acked → Accepted`, `Receipt.Read → Read`, `Queued → Queued`,
   `Failed → Failed`. Лестницу P2P не менять (у неё свой контракт).

### 1.4 CLI

Терминал рисует текстом в сетке — наложить одну галочку на другую там
невозможно, и `✓✓` в `src/ui.js` остаётся как есть. **Это решение, а не
забывчивость: записать его в worklog явно** (§13: «не тронуто намеренно,
потому что…»). Размер в терминале задаёт шрифт пользователя — менять нечего.

---

## 2. B — выделение в APK убирает метки

`CloudMessageBubble` уже знает про режим: параметр `selectionCount`
(`CloudScreen.kt:2636`). В строке меты (`:2863`) условие
`if (message.mine)` становится `if (message.mine && selectionCount == 0)`.
Время, `✎`, `⏰` и реакции остаются — убирается только метка доставки, потому
что кружок выделения (`:2878-2900`) рисует свою ✓ и два разных смысла одной
галочки в одном бабле читаются как ошибка.

Веб не трогаем: там выделение — только заливка `.row-selected`, своей
галочки у него нет, конфликта нет. Записать в worklog как осознанное
«не тронуто» (§13).

---

## 3. C — каждое сообщение отдельное

Удаляется вся группировка, а не прячется флагом. Это чистый переход (§
Delivery): мёртвые функции, константы, классы и тесты уходят вместе с ней.

### 3.1 Web
1. `web/cloud/app.js`: удалить `MESSAGE_SERIES_GAP_MS` (`:12161`),
   `normalizeMessageSeries` (`:12163-12187`) и её вызов в
   `normalizeDateDividers` (`:12213`).
2. Проверить `grep` по `series-start|series-end|\.hidden = ` в `app.js`: ни
   `.bubble-author`, ни `.bubble-meta` больше никто не должен прятать. Оба
   элемента создаются видимыми (`:4741-4758`, `:8730-8752`), так что удаления
   достаточно.
3. `web/cloud/app.css`: удалить `.row.series-end` (`:2068-2070`) и поднять
   базовый `.row { margin-bottom: 3px }` до `6px` — расстояние между
   сообщениями теперь одно на все пары (раньше 3 px внутри серии, 6 px между).
4. Удалить тест `test/web-preload-receipts.test.js:138-150` («every own
   message keeps its receipt visible inside a visual series») — он закрепляет
   именно то поведение, которое снимается, включая
   `'incoming timestamps may remain grouped'`.

### 3.2 APK
1. `CloudScreen.kt`: удалить `MESSAGE_SERIES_GAP_MS` (`:2603`),
   `sameMessageSeries` (`:2605-2613`), `startsSeries`/`endsSeries`
   (`:2215-2216`).
2. Вызов бабла (`:2220-2225`): убрать `showAuthor`/`showMeta`, отступ сделать
   постоянным — `Modifier.padding(top = 6.dp)`.
3. Параметры `showAuthor`/`showMeta` (`:2626-2627`) удалить; условия `:2767`
   (`if (showAuthor && label != null)` → `if (label != null)`) и `:2812`
   (`if (showMeta || message.reactions.isNotEmpty())` → строка меты рисуется
   всегда) упростить. Комментарий «Grouped incoming messages reveal it only as
   needed» (`:2814-2815`) снять.
4. Разделитель дня (`DayDivider`) остаётся — это не группировка сообщений.

### 3.3 CLI
1. `src/ui.js`: удалить `sameSeries` (`:159-168`); в `draw()` (`:170-182`)
   оставить `entries.map(entry => textOf(entry)).join('\n')`, вместе с
   `entry.groupKey`.
2. `renderMessageMarkup` (`:1119-1159`): параметры `showAuthor`/`showMeta`
   становятся константами — удалить их и ветки (`:1128`, `:1145-1146`,
   `:1150-1151`, `:1158-1159`). Перед удалением — `grep showAuthor|showMeta`
   по `src/` и `test/`: сейчас других потребителей нет, но проверить обязано
   быть в задаче, а не в отчёте.
3. `test/ui.test.js:511`: формулировка «even when only the series tail renders
   a marker» перестаёт быть правдой — поправить текст ассерта (сам ассерт
   остаётся валидным).

---

## 4. Радиус проверки (§13) — перечислить и исполнить, не только собрать

Потребители меняемого:
* `--receipt-size` → мета бабла **и** превью ростера в вебе; `RECEIPT_SIZE`/
  `RECEIPT_HEIGHT` → те же две поверхности в APK **плюс** P2P-экран;
* `setMark` → четыре vm-теста (список в §1.2.5), живой транскрипт, превью
  ростера, восстановление из `/api/history`, фид синхронизации, очередь
  отправки;
* группировка → транскрипт всех трёх клиентов, копирование выделенного в CLI
  (`computeCopyPadding` в `src/ui.js` считает отступы в такт `draw()`:
  `test/paste.test.js`), подсчёт отступов в вебе, скриншоты в
  `docs/android-notes.md`;
* `?v=` в `package.json` → доедет ли бандл до установленной PWA (§7).

Запуск:
* `node --test test/` целиком (а не только затронутые файлы); отдельно
  обязательны `test/ui.test.js`, `test/cli.test.js`, `test/paste.test.js`,
  `test/web-*.test.js`, `test/cloud-sw.test.js`, и по §3 AGENTS —
  `node --test test/wide-chars.test.js test/menu.test.js`;
* `./gradlew :app:testDebugUnitTest` (там `CloudReceiptGlyphTest`,
  `RosterPreviewLineTest` — последний правится под `CloudDelivery?`);
* **живой веб** в браузере: свой/чужой бабл, `⧗ → ✓ → ✓✓ → ✓✓ зелёные`,
  строка ростера, тёмная и светлая темы, узкая колонка (телефонный layout),
  режим выделения (метки остаются), удалённое сообщение;
* **живой APK** на эмуляторе/телефоне: те же рунги в бабле и в ростере, вход
  в выделение (метки исчезают, кружок остаётся), выход (возвращаются),
  P2P-экран, два подряд своих сообщения — у каждого своё время и своя метка;
* **живой CLI**: два подряд своих сообщения в терминале — у каждого свой
  `{name}` и `[HH:MM]`; копирование выделения не съедает символы.

Скриншоты/кадры — в отчёт; «тесты зелёные» проверкой формы не являются.

## 5. Релиз (§7 / §8 / §9)

1. `package.json` 1.126 → 1.127 **и в том же коммите**: два `?v=` в
   `web/cloud/index.html` (`:16-17`), два `?v=` в `web/cloud/sw.js` (`:6-7`),
   `CACHE_NAME` `tailchat-cloud-v165` → `v166` (`sw.js:2`), литерал `v166` в
   `test/cloud-sw.test.js`. Четыре правки, не три.
2. Android: `versionCode 181 → 182`, `versionName` на шаг
   (`android/app/build.gradle.kts:17-18`).
3. `docs/android-notes.md`: секция для сборки 182 — все главные изменения
   после прошлой APK-сборки, человеческим языком, без технических деталей
   (§9, исключение про build note). Без неё `bin/release-android.js` предупредит.
4. `git push origin main` → `node bin/release-cloud.js` → `node bin/release-android.js`.
5. Проверить: `/health` = `{"ok":true}`, `app.js?v=1.127` отдаётся 200,
   SHA-256 опубликованного APK совпадает с локальным, `aapt2` показывает
   `versionCode 182`, и **ни в одной беседе не появилось `release-*`**
   (§9: `RELEASE_ANNOUNCEMENTS` остаётся `false`, `announcedVersion` в
   проде не двигается). Проверять именно стор, а не конверт.
6. Записать в `docs/worklog.md` и `android/HANDOFF.md`: что меняли, что
   намеренно не трогали (CLI-форма метки, выделение в вебе), что запускали и
   что видели.

## 6. Готово — это когда

* ни в одном клиенте нет текстовой `✓`/`✓✓` на экране (кроме CLI, где так
  решено осознанно);
* метка одной геометрии и одного размера в бабле и в ростере, обе галочки
  ровные, вторая перекрывает первую;
* в APK в режиме выделения метки доставки нет, кружок выделения есть;
* два подряд сообщения одного автора показывают два заголовка, два времени и
  две метки — в вебе, в APK и в терминале;
* `node --test test/` и `./gradlew :app:testDebugUnitTest` зелёные;
* релиз выпущен и проверен по §5, worklog и HANDOFF дописаны;
* записи в `docs/backlog.md` и `AGENTS.md` §14 про этот план сняты — это
  последний шаг, не первый.
