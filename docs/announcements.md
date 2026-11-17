# Сообщения о релизах

> **Рассылка выключена** (2026-09-18, решение владельца — `AGENTS.md` § 9).
> Сервисный аккаунт `tailchat` не пишет никому: ни при обновлении
> облака/веба/CLI, ни при регистрации нового аккаунта. **Новые записи сюда не
> добавлять** — при выключенной рассылке их никто не читает. О выпуске APK
> узнают из попапа обновления внутри Android-клиента (`android-version.json`),
> а не из чата. Файл оставлен целиком: рассылка возвращается одним флагом
> `RELEASE_ANNOUNCEMENTS` в `src/cloud/service-account.js`, и тексты снова
> берутся отсюда.

Тексты, которые сервисный аккаунт `tailchat` рассылал в личный чат при
выкладке версии (`releaseNotes` в `src/cloud/service-account.js`). Новые
записи сверху: `## <версия>`, внутри — `### ru` / `### en` / `### fr`.
Версия — это версия из `package.json` (её сервер объявляет как `VERSION`), а
не `versionName` Android-сборки: релиз мобильного клиента доезжал до людей
вместе с бампом облака.

Тело подсекции попадает в чат дословно, поэтому одна строка здесь — одна
строка в пузыре: переносы для красоты файла превратятся в разрывы посреди
фразы. Это сообщение в чате, а не страница релиза: одно-два предложения о том,
что человек заметит сам. Версия без секции рассылается общей фразой из
`releaseNotes`, язык без подсекции берёт `ru`, тело обрезается на 1200
символах.

## 1.47

### ru

Добавлены закрепление важных контактов сверху списка, пересылка сообщений, регулировка скорости прослушивания голосовых и блокировка контактов — всё одинаково работает в вебе, в приложении и в терминале. Заблокированный собеседник не сможет вам написать, а вы — ему, но история переписки никуда не пропадёт.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### en

Added pinning important contacts to the top of the list, forwarding messages, adjustable voice message playback speed, and contact blocking — all work the same way on web, in the app, and in the terminal. A blocked contact can no longer message you, and you can't message them either, but your history with them stays exactly where it was.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### fr

Ajout de l'épinglage des contacts importants en haut de la liste, du transfert de messages, du réglage de la vitesse de lecture des messages vocaux, et du blocage de contacts — le tout fonctionne de la même façon sur le web, dans l'application et dans le terminal. Un contact bloqué ne peut plus vous écrire, et vous ne pouvez plus lui écrire non plus, mais votre historique avec lui reste intact.
APK : https://repentandliveholy.org/tailchat/tailchat.apk

## 1.36

### ru

Обновление только для Android-клиента — облако не менялось. Токен сессии теперь хранится зашифрованным ключом Android Keystore вместо открытого текста. Исправлена самопроверка обновлений: на Android 10–12 кнопка «Обновить» никогда не показывала новую версию из-за внутренней ошибки — теперь показывает. Добавлена страница «Диагностика» в настройках с версией, статусом связи и очередью на отправку, а для скачанного APK теперь проверяются его размер, версия и (когда сервер публикует) контрольная сумма перед установкой.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### en

Android-only update — the server did not change. The session token is now stored encrypted with an Android Keystore key instead of in plain text. Fixed the self-update check: on Android 10–12 the "Update" button never surfaced a newer version because of an internal bug — it now does. Added a "Diagnostics" page in settings with version, connection status and send queue, and a downloaded APK is now checked for its version and (when the server publishes one) a checksum before install.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### fr

Mise à jour Android uniquement — le serveur n'a pas changé. Le jeton de session est désormais chiffré par une clé de l'Android Keystore au lieu d'être stocké en clair. La vérification de mise à jour est corrigée : sur Android 10–12, le bouton « Mettre à jour » ne détectait jamais de nouvelle version à cause d'un bug interne — c'est réparé. Une page « Diagnostics » a été ajoutée dans les réglages (version, état de la connexion, file d'envoi), et l'APK téléchargé est désormais vérifié (version, et somme de contrôle quand le serveur la publie) avant l'installation.
APK : https://repentandliveholy.org/tailchat/tailchat.apk

## 1.35

### ru

Обновление только для Android-клиента — облако не менялось. Голосовые сообщения больше не сбрасываются при блокировке экрана во время записи, кнопку микрофона теперь нужно удерживать, а не нажимать, чтобы начать запись, а лого в шапке списка чатов перестало переигрывать анимацию при каждом выходе из переписки. Нажмите «Обновить» внизу списка чатов — приложение само скачает и поставит новую версию; если кнопки нет, скачайте APK по ссылке ниже и откройте файл — Android один раз спросит разрешение на установку из этого источника, разрешите его.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### en

Android-only update — the server did not change. Voice notes no longer get discarded if you lock the screen mid-recording, the mic button now needs a hold instead of a tap to start one, and the chat list's logo stopped replaying its animation every time you leave a conversation. Tap "Update" at the bottom of the chat list — the app downloads and installs the new build itself; if the button is missing, download the APK from the link below and open it — Android will ask once to allow installs from this source, allow it.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### fr

Mise à jour Android uniquement — le serveur n'a pas changé. Les messages vocaux ne sont plus perdus si vous verrouillez l'écran pendant l'enregistrement, il faut désormais maintenir le bouton du micro au lieu de le toucher pour démarrer un enregistrement, et le logo de la liste des discussions ne rejoue plus son animation à chaque sortie d'une conversation. Appuyez sur « Mettre à jour » en bas de la liste des discussions — l'application télécharge et installe elle-même la nouvelle version ; si le bouton est absent, téléchargez l'APK via le lien ci-dessous et ouvrez-le — Android demandera une seule fois l'autorisation d'installer depuis cette source, acceptez-la.
APK : https://repentandliveholy.org/tailchat/tailchat.apk

## 1.34

### ru

Само по себе «Слишком много попыток» появляться больше не должно: сервер перестал пересобирать файл аккаунтов на каждый запрос и рассылать список собеседников на каждое прочитанное сообщение, а телефон — отвечать на обрыв мгновенным переподключением. Обновите приложение, чтобы получить клиентскую половину исправлений.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### en

"Too many attempts" should no longer appear on its own: the server stopped rebuilding its account file on every request and every roster on every read receipt, and the phone no longer reconnects the instant a socket drops. Update the app to get the client half of the fixes.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### fr

« Trop de tentatives » ne devrait plus apparaître tout seul : le serveur ne réécrit plus son fichier de comptes à chaque requête ni la liste des contacts à chaque message lu, et le téléphone ne se reconnecte plus immédiatement après une coupure. Mettez l'application à jour pour recevoir la moitié client des corrections.
APK : https://repentandliveholy.org/tailchat/tailchat.apk

## 1.33

### ru

Одно сообщение — одно уведомление: push-подписки теперь привязаны к конкретному устройству, и брошенная подписка больше не звенит со всех сторон вместе с телефоном. Переписки подгружаются в фоне заранее, поэтому диалог открывается мгновенно и читается без сети.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### en

One message, one notification: push subscriptions are now tied to a specific device, so an abandoned one no longer buzzes alongside your phone. Conversations are fetched in the background ahead of time, so a thread opens instantly and is readable offline.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### fr

Un message, une notification : les abonnements push sont désormais liés à un appareil précis, si bien qu'un appareil abandonné ne vibre plus en même temps que votre téléphone. Les conversations sont préchargées en arrière-plan : un fil s'ouvre instantanément et reste lisible hors ligne.
APK : https://repentandliveholy.org/tailchat/tailchat.apk

## 1.32

### ru

Android теперь умеет обновляться сам — кнопка «Обновить» на списке чатов скачивает новую версию и запускает установку. Исправлено: своё сообщение больше не «прыгает» ниже нового от собеседника, пересылка открывает полноценный список контактов вместо голого меню, Saved Messages выделены цветом как служебные чаты, а непрочитанные сообщения корректно считаются, даже если вернуться в список чатов, не закрывая переписку явно.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### en

Android can now update itself — a new "Update" button on the chat list downloads the latest build and starts the install. Fixed: your own message no longer jumps below a newer one from the other side, forwarding now opens a proper contact list instead of a bare menu, Saved Messages is coloured like the other service chats, and unread counts stay correct even after returning to the chat list without explicitly closing a conversation.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### fr

Android peut désormais se mettre à jour lui-même — un bouton « Mettre à jour » sur la liste des conversations télécharge la nouvelle version et lance l'installation. Corrections : votre propre message ne saute plus sous un message plus récent de l'interlocuteur, le transfert ouvre désormais une vraie liste de contacts au lieu d'un simple menu, Saved Messages est coloré comme les autres comptes de service, et le compteur de non-lus reste correct même après un retour à la liste sans fermer explicitement la conversation.
APK : https://repentandliveholy.org/tailchat/tailchat.apk

## 1.31

### ru

У Android-клиента новая иконка — фирменный кот вместо шеврона, более округлый дизайн карточек и пузырей, а корневой список диалогов теперь по-настоящему выходит из приложения: одно нажатие «Назад» показывает подсказку, второе — сворачивает приложение. Официальный аккаунт tailchat выделен вторым цветом в списке, а число строк превью сообщения в ростере теперь настраивается.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### en

The Android client has a new icon — the brand cat instead of a shell prompt — a rounder overall design, and the root conversation list now genuinely exits: one Back press shows a hint, a second one backgrounds the app. The official tailchat account is now highlighted in a second colour in the list, and how many lines a roster preview wraps to is configurable.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### fr

Le client Android a une nouvelle icône — le chat de la marque au lieu d'un chevron —, un design plus arrondi, et la liste racine des conversations permet désormais vraiment de quitter l'application : un appui sur Retour affiche une astuce, un second met l'application en arrière-plan. Le compte officiel tailchat est mis en évidence dans une seconde couleur, et le nombre de lignes d'aperçu dans la liste est réglable.
APK : https://repentandliveholy.org/tailchat/tailchat.apk

## 1.30

### ru

Голосовые сообщения — теперь до 10 минут, с волновой дорожкой и перемоткой в Android-плеере. Исправлен счётчик непрочитанных: он больше не улетал за 500 из-за служебных кадров (прочитано/доставлено) в очереди — считаются только настоящие сообщения.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### en

Voice messages now run up to 10 minutes, with a waveform and scrubbing in the Android player. Fixed the unread counter: it no longer inflated past 500 from queued receipts and other control frames — only real messages count now.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### fr

Les messages vocaux durent désormais jusqu'à 10 minutes, avec une forme d'onde et une navigation dans le lecteur Android. Le compteur de non-lus est corrigé : il ne dépassait plus 500 à cause des accusés de réception en file d'attente — seuls les vrais messages comptent désormais.
APK : https://repentandliveholy.org/tailchat/tailchat.apk

## 1.29

### ru

Android: офлайн-фото и сообщения теперь всегда доходят после возврата сети — раньше застрявшая офлайн-фотография блокировала очередь навсегда. В вебе экран теперь следует вниз, когда собеседник печатает.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### en

Android: an offline photo or message now always sends once the network is back — a stuck offline photo used to jam the queue forever. On the web, the screen now follows down while the other side is typing.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### fr

Android : une photo ou un message envoyé hors ligne arrive désormais toujours au retour du réseau — une photo hors ligne bloquée figeait la file pour de bon. Sur le web, l'écran suit maintenant vers le bas quand l'autre personne écrit.
APK : https://repentandliveholy.org/tailchat/tailchat.apk

## 1.28

### ru

Появилась пересылка сообщений — в вебе, в приложении и в терминале. У tailik теперь свой контакт: пишите ему напрямую, без упоминаний.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### en

Message forwarding is here — on the web, in the app and in the terminal. tailik now has its own contact: write to it directly, no mentions needed.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### fr

Le transfert de messages est arrivé — sur le web, dans l’application et dans le terminal. tailik a désormais son propre contact : écrivez-lui directement, sans mention.
APK : https://repentandliveholy.org/tailchat/tailchat.apk

## 1.27

### ru

Android больше не висит в шторке: фон выключен по умолчанию (включается в настройках «Работать в фоне»), уведомление про батарею спрашивается один раз, а не каждый запуск. Индикатор «печатает…» с телефона наконец виден в вебе, вертикальные фото больше не растягивают пузырь. Время сообщений теперь общее — серверное, так что порядок ленты одинаков на всех клиентах. В вебе: «Отметить прочитанным» в меню собеседника, залипшие непрочитанные лечатся, быстрые реакции 👍/👎, «Ответить» выше «Реакции». Аккаунт Tailchat всегда на связи и помечен синим.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### en

Android no longer sits in the notification shade: background mode is off by default (turn on «Run in the background» in settings), and the battery dialog is asked once per install instead of every launch. Typing from a phone is finally visible on the web, and portrait photos no longer stretch the bubble. Message time is now the server's, so every client shows the same order. Web: «Mark as read» in the peer menu, stuck unread badges fixed, 👍/👎 quick reactions, Reply above React. The Tailchat account is always reachable and marked in blue.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### fr

Android ne reste plus dans le volet des notifications : le mode arrière-plan est désactivé par défaut (« Fonctionner en arrière-plan » dans les réglages) et la demande liée à la batterie n’apparaît qu’une seule fois. L’indicateur « écrit… » depuis le téléphone est enfin visible sur le web et les photos verticales n’étirent plus la bulle. L’heure des messages vient désormais du serveur : l’ordre est le même partout. Web : « Marquer comme lu » dans le menu du contact, badges non lus bloqués corrigés, réactions rapides 👍/👎, Répondre au-dessus de Réagir. Le compte Tailchat est toujours joignable et affiché en bleu.
APK : https://repentandliveholy.org/tailchat/tailchat.apk

## 1.26

### ru

Android: фото и скриншоты уходят в полном разрешении (2560 px вместо 800 — текст на скриншоте теперь читается), файлы до 100 МБ вместо 25, отправленное сообщение больше не остаётся за краем экрана, а чат с новым сообщением поднимается наверх списка.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### en

Android: photos and screenshots are sent at full resolution (2560 px instead of 800, so text in a screenshot is readable), files up to 100 MB instead of 25, a message you just sent no longer stays off screen, and a conversation with a new message moves to the top of the list.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### fr

Android : les photos et captures d’écran partent en pleine résolution (2560 px au lieu de 800, le texte d’une capture est enfin lisible), les fichiers vont jusqu’à 100 Mo au lieu de 25, un message que vous venez d’envoyer ne reste plus hors écran, et une conversation avec un nouveau message remonte en haut de la liste.
APK : https://repentandliveholy.org/tailchat/tailchat.apk

## 1.25

### ru

Android-клиент больше не падает и не отваливается от сети: исправлены аварийная перезагрузка приложения по будильнику, вылет при получении сообщения и цикл переподключений, из-за которого разряжалась батарея. Обновите APK.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### en

The Android client no longer crashes or drops the connection: the alarm-driven restart crash, the crash on an incoming message and the reconnect loop that drained the battery are all fixed. Please update the APK.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### fr

Le client Android ne plante plus et ne perd plus la connexion : le plantage au réveil programmé, celui à l’arrivée d’un message et la boucle de reconnexion qui vidait la batterie sont corrigés. Mettez l’APK à jour.
APK : https://repentandliveholy.org/tailchat/tailchat.apk

## 1.24

### ru

Обновлённый нативный Android-клиент: переписка кэшируется на устройстве — история читается офлайн, плавная прокрутка фотографий, выбор шрифта, скругления, масштаба текста и звуков, меню сообщения по одному нажатию, отдельная кнопка эмодзи, меньший расход батареи.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### en

A rebuilt native Android client: the conversation is cached on the device, so history reads offline, photos scroll smoothly, and the font, corner rounding, text scale and sounds are yours to pick. The message menu opens with a single tap, emoji have their own button, and the battery lasts longer.
APK: https://repentandliveholy.org/tailchat/tailchat.apk

### fr

Un client Android natif reconstruit : la conversation est mise en cache sur l’appareil, l’historique se lit hors ligne, les photos défilent sans à-coups, et la police, l’arrondi, la taille du texte et les sons se choisissent. Le menu du message s’ouvre d’une seule pression, les emoji ont leur bouton, et la batterie tient plus longtemps.
APK : https://repentandliveholy.org/tailchat/tailchat.apk
