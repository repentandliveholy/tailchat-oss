# Новости сборки APK

Тексты сообщения, которое `{tailchat}` отправляет человеку, поставившему сборку:
один раз на сборку, и только тому, у кого она стоит (`announceAppBuild` в
`src/cloud/service-account.js`; клиент сообщает свой `versionCode` при
подключении). Заголовок раздела — `versionCode` из
`android/app/build.gradle.kts`, языки — `ru` / `en` / `fr`, пишутся сначала
по-русски.

Правило: только то, что видит и понимает конечный пользователь — коротко, по
делу, самое главное, что добавлено или изменилось именно в этой сборке. Рабочие
подробности остаются в `docs/worklog.md`. Сборка без раздела выпускается
свободно: сообщения не будет вовсе (`bin/release-android.js` про это
предупреждает). Общей рассылки о релизах по-прежнему нет — `RELEASE_ANNOUNCEMENTS`
в `src/cloud/service-account.js` выключен, `docs/announcements.md` в этом не
участвует.

Секция 173 отсутствует намеренно: тогда строку поиска только сделали таким же
баблом, как строки контактов, а в 174 она уже всегда на виду — то, что человек
в итоге увидит, описано один раз, в 174.

## 190

### ru

Что изменилось в этой сборке:

· когда собеседник исправляет своё сообщение в защищённой беседе, в чате больше не появляется лишнее сообщение «🔒 Зашифрованное сообщение — обновите приложение».

### en

What's changed in this build:

· when someone edits their message in a protected conversation, an extra 🔒 "encrypted message" notice no longer appears in the chat.

### fr

Ce qui change dans cette version :

· quand votre interlocuteur corrige son message dans une conversation protégée, l'avis 🔒 « message chiffré » en trop n'apparaît plus dans la discussion.

## 189

### ru

Что изменилось в этой сборке:

· исправлено: беседа с большим количеством голосовых и фото могла остановиться на старых сообщениях, а новые не появлялись — теперь вся история догружается даже при медленной сети;
· голосовые сообщения, записанные на компьютере или загруженные файлом, больше не показываются пустыми;
· если историю беседы всё же не удалось загрузить, вы увидите об этом сообщение, а не просто пустое место.

### en

What's changed in this build:

· fixed: a conversation with many voice notes and photos could stop at older messages while newer ones never appeared — the whole history now loads, even on a slow connection;
· voice notes recorded on a computer or uploaded as a file no longer appear empty;
· if a conversation's history still can't be loaded, you'll see a message saying so instead of a blank space.

### fr

Ce qui change dans cette version :

· corrigé : une conversation contenant beaucoup de messages vocaux et de photos pouvait s’arrêter sur d’anciens messages sans afficher les nouveaux — tout l’historique se charge désormais, même avec une connexion lente ;
· les messages vocaux enregistrés sur un ordinateur ou envoyés sous forme de fichier ne s’affichent plus vides ;
· si l’historique d’une conversation ne peut toujours pas être chargé, un message vous le signale au lieu d’un espace vide.

## 188

### ru

Что изменилось в этой сборке:

· новая плавная шкала уровня микрофона при записи голосовых вместо случайно меняющихся столбиков;
· реакции открываются отдельным прокручиваемым столбиком, а не двумя рядами в меню; доступны 32 настраиваемые быстрые реакции, в том числе по нажатию рядом с сообщением или картинкой;
· полный набор эмодзи с поиском и недавними; одинаковый вид в сообщениях, цитатах, списке бесед и черновиках, включая подпись к картинке;
· просмотр, обрезка, поворот и подпись картинки перед отправкой, в том числе при вставке из буфера или экранной клавиатуры;
· изображения без подписи — без лишнего бабла, с подписью — компактно; маленькие картинки не растягиваются, время и галочки располагаются поверх фото;
· полноэкранный просмотр картинок с масштабированием, перелистыванием и сохранением;
· адаптивные превью ссылок без пустых мест, с отдельным выключателем в настройках;
· согласованы объёмный и плоский дизайн, обводки и тональные баблы; объём и обводки переключаются отдельно;
· убрана серая подложка при нажатии на кнопки и другие элементы;
· сообщения компактнее, статусы чтения и редактирования — внизу меню; непрочитанные реакции выделяются отдельно.

### en

What's changed in this build:

· a smooth microphone level meter while recording voice notes, replacing the randomly changing bars;
· reactions open in a separate scrollable column instead of two menu rows, with 32 customizable quick reactions, also accessible by tapping beside a message or image;
· a full emoji picker with search and recents, and consistent emoji in messages, quotes, the conversation list and drafts, including image captions;
· preview, crop, rotate and caption images before sending, including images pasted from the clipboard or an on-screen keyboard;
· captionless images have no extra bubble, captions stay compact, small images are not stretched, and time and delivery marks sit over the photo;
· full-screen image viewing with zoom, browsing and saving;
· adaptive link previews without empty spaces, with a separate switch in settings;
· consistent depth, flat design, outlines and tonal bubbles; depth and outlines have separate switches;
· removed the gray backdrop when pressing buttons and other controls;
· more compact messages, read and edit details at the bottom of the menu, and separate unread-reaction highlights.

### fr

Ce qui change dans cette version :

· un indicateur fluide du niveau du microphone pendant l’enregistrement vocal, à la place des barres qui changeaient aléatoirement ;
· les réactions s’ouvrent dans une colonne défilante séparée, et non sur deux rangées du menu, avec 32 réactions rapides personnalisables, accessibles aussi par un appui à côté d’un message ou d’une image ;
· une palette complète d’émojis avec recherche et récents, et un rendu cohérent dans les messages, citations, la liste des conversations et les brouillons, y compris les légendes d’images ;
· prévisualisez, recadrez, faites pivoter et légendez les images avant l’envoi, y compris depuis le presse-papiers ou le clavier à l’écran ;
· les images sans légende n’ont plus de bulle superflue, les légendes restent compactes, les petites images ne sont pas étirées, et l’heure et les coches se placent sur la photo ;
· un affichage plein écran avec zoom, défilement et enregistrement ;
· des aperçus de liens adaptatifs sans espaces vides, désactivables séparément dans les réglages ;
· un rendu cohérent du relief, du mode plat, des contours et des bulles teintées ; le relief et les contours se règlent séparément ;
· suppression du fond gris lors d’un appui sur les boutons et autres commandes ;
· des messages plus compacts, les détails de lecture et de modification en bas du menu, et une mise en évidence distincte des réactions non lues.

## 187

### ru

Что изменилось в этой сборке:

· реакции открываются отдельным прокручиваемым столбиком, а не двумя рядами в меню; доступны 32 настраиваемые быстрые реакции, открыть их можно и нажатием рядом с сообщением или картинкой;
· полный набор эмодзи с поиском и недавними; одинаковый вид в сообщениях, цитатах, списке бесед и прямо в черновике, включая подпись к картинке; длинный черновик прокручивается к курсору;
· картинку можно посмотреть, обрезать, повернуть и подписать перед отправкой, в том числе при вставке из буфера или экранной клавиатуры; поле подписи остаётся над клавиатурой;
· изображения без подписи показываются без лишнего бабла, с подписью — компактно; маленькие картинки не растягиваются, время и галочки располагаются поверх фото;
· полноэкранный просмотр картинок с масштабированием, перелистыванием и сохранением;
· адаптивные превью ссылок без пустых мест; их можно выключить в настройках;
· объёмный и плоский дизайн, обводки и тональные баблы согласованы между экранами; объём и обводки переключаются отдельно;
· убрана серая подложка, появлявшаяся при нажатии на кнопки и другие элементы;
· сообщения компактнее, статусы чтения и редактирования находятся внизу меню; непрочитанные реакции выделяются отдельно.

### en

What's changed in this build:

· reactions open in a separate scrollable column instead of two rows in the menu, with 32 customizable quick reactions; tap beside a message or image to open them too;
· a full emoji picker with search and recents, with consistent emoji in messages, quotes, the conversation list and directly in drafts, including image captions; long drafts scroll to the cursor;
· preview, crop, rotate and caption images before sending, including images pasted from the clipboard or an on-screen keyboard; the caption stays above the keyboard;
· captionless images have no extra bubble, captions stay compact, small images are not stretched, and time and delivery marks sit over the photo;
· full-screen image viewing with zoom, browsing and saving;
· adaptive link previews without empty spaces, with a switch to turn them off;
· consistent depth, flat design, outlines and tonal bubbles across screens; depth and outlines have separate switches;
· removed the gray backdrop that appeared when pressing buttons and other controls;
· more compact messages, read and edit details at the bottom of the menu, and separate unread-reaction highlights.

### fr

Ce qui change dans cette version :

· les réactions s’ouvrent dans une colonne défilante séparée, et non sur deux rangées du menu, avec 32 réactions rapides personnalisables ; un appui à côté d’un message ou d’une image les ouvre aussi ;
· une palette complète d’émojis avec recherche et récents, et un rendu cohérent dans les messages, citations, la liste des conversations et directement dans les brouillons, y compris les légendes d’images ; les longs brouillons défilent jusqu’au curseur ;
· prévisualisez, recadrez, faites pivoter et légendez les images avant l’envoi, y compris depuis le presse-papiers ou le clavier à l’écran ; la légende reste au-dessus du clavier ;
· les images sans légende n’ont plus de bulle superflue, les légendes restent compactes, les petites images ne sont pas étirées, et l’heure et les coches se placent sur la photo ;
· un affichage plein écran avec zoom, défilement et enregistrement ;
· des aperçus de liens adaptatifs sans espaces vides, désactivables dans les réglages ;
· un rendu cohérent du relief, du mode plat, des contours et des bulles teintées ; le relief et les contours se règlent séparément ;
· suppression du fond gris qui apparaissait lors d’un appui sur les boutons et autres commandes ;
· des messages plus compacts, les détails de lecture et de modification en bas du menu, et une mise en évidence distincte des réactions non lues.

## 186

### ru

Что изменилось в этой сборке:

· реакции теперь открываются отдельным прокручиваемым столбиком, а не двумя рядами в меню; доступны 32 настраиваемые быстрые реакции;
· полный набор эмодзи с поиском и недавними; эмодзи одинаково выглядят в сообщениях, цитатах и списке бесед;
· картинку можно посмотреть, обрезать, повернуть и подписать перед отправкой, в том числе при вставке из буфера или экранной клавиатуры;
· изображения без подписи показываются без лишнего бабла, с подписью — компактно; маленькие картинки не растягиваются, время и галочки располагаются поверх фото;
· полноэкранный просмотр картинок с масштабированием, перелистыванием и сохранением;
· адаптивные превью ссылок без пустых мест; их можно выключить в настройках;
· объёмный и плоский дизайн, обводки и тональные баблы согласованы между экранами; объём и обводки переключаются отдельно;
· сообщения компактнее, статусы чтения и редактирования находятся внизу меню; непрочитанные реакции выделяются отдельно.

### en

What's changed in this build:

· reactions open in a separate scrollable column instead of two rows in the menu, with 32 customizable quick reactions;
· a full emoji picker with search and recents, with consistent emoji in messages, quotes and the conversation list;
· preview, crop, rotate and caption images before sending, including images pasted from the clipboard or an on-screen keyboard;
· captionless images have no extra bubble, captions stay compact, small images are not stretched, and time and delivery marks sit over the photo;
· full-screen image viewing with zoom, browsing and saving;
· adaptive link previews without empty spaces, with a switch to turn them off;
· consistent depth, flat design, outlines and tonal bubbles across screens; depth and outlines have separate switches;
· more compact messages, read and edit details at the bottom of the menu, and separate unread-reaction highlights.

### fr

Ce qui change dans cette version :

· les réactions s’ouvrent dans une colonne défilante séparée, et non sur deux rangées du menu, avec 32 réactions rapides personnalisables ;
· une palette complète d’émojis avec recherche et récents, et un rendu cohérent dans les messages, citations et la liste des conversations ;
· prévisualisez, recadrez, faites pivoter et légendez les images avant l’envoi, y compris depuis le presse-papiers ou le clavier à l’écran ;
· les images sans légende n’ont plus de bulle superflue, les légendes restent compactes, les petites images ne sont pas étirées, et l’heure et les coches se placent sur la photo ;
· un affichage plein écran avec zoom, défilement et enregistrement ;
· des aperçus de liens adaptatifs sans espaces vides, désactivables dans les réglages ;
· un rendu cohérent du relief, du mode plat, des contours et des bulles teintées ; le relief et les contours se règlent séparément ;
· des messages plus compacts, les détails de lecture et de modification en bas du menu, et une mise en évidence distincte des réactions non lues.

## 185

### ru

Что изменилось в этой сборке:

· обновлён набор эмодзи для вставки: убраны нежелательные символы; существующие сообщения и история не меняются.

Также обновилась веб-версия:

· сообщения компактнее: время рядом с текстом, без повторения имён в обычной переписке; галочки и время в списке бесед выровнены;
· перед отправкой картинки можно посмотреть, обрезать, повернуть и подписать; в беседе изображения крупнее, с округлой формой и компактной подписью, а при открытии — на весь экран с масштабированием и перелистыванием;
· превью ссылок подстраиваются под содержимое, без пустых мест от отсутствующих картинок;
· эмодзи стали меньше и выглядят одинаково; полный набор — с поиском и недавними, быстрые реакции можно настроить;
· 32 быстрые реакции: при наведении появляется одна, затем раскрывается прокручиваемый столбик; небольшая задержка защищает от случайного открытия, а входящие сообщения больше не прячут панель; меню действий открывается правой кнопкой, на телефоне — удержанием;
· поле подписи к картинке выровнено по центру; объёмный дизайн включён по умолчанию, его и обводки можно переключать в настройках.

### en

What's changed in this build:

· the emoji insertion palette has been updated to remove unwanted symbols; existing messages and history are unchanged.

The web version has also been updated:

· more compact messages: time sits beside the text, without repeated names in ordinary chats; delivery marks and times are aligned in the conversation list;
· preview, crop, rotate and caption images before sending; chat images are larger, with rounded corners and compact captions, and open full-screen with zoom and browsing;
· link previews adapt to their content, without empty spaces from missing images;
· smaller, consistent-looking emoji; a full picker with search and recents, and customizable quick reactions;
· 32 quick reactions: hover shows one, then expands a scrollable column; a short delay prevents accidental opening, and incoming messages no longer hide the panel; right-click opens message actions, or hold on a phone;
· image captions are vertically centered; the depth design is on by default, with switches for it and outlines in settings.

### fr

Ce qui change dans cette version :

· la palette d’insertion des émojis a été mise à jour pour retirer les symboles indésirables ; les messages et l’historique existants restent inchangés.

La version web a également été mise à jour :

· des messages plus compacts : l’heure est à côté du texte, sans répéter les noms dans les discussions ordinaires ; les coches et les heures sont alignées dans la liste des conversations ;
· prévisualisez, recadrez, faites pivoter et légendez les images avant l’envoi ; dans la discussion, elles sont plus grandes, arrondies et accompagnées de légendes compactes, puis s’ouvrent en plein écran avec zoom et défilement ;
· les aperçus des liens s’adaptent au contenu, sans espaces vides lorsqu’une image manque ;
· des émojis plus petits et d’apparence uniforme ; une palette complète avec recherche et récents, et des réactions rapides personnalisables ;
· 32 réactions rapides : le survol en montre une, puis ouvre une colonne défilante ; un court délai évite les ouvertures accidentelles, et les messages entrants ne masquent plus le panneau ; clic droit pour les actions, ou appui long sur téléphone ;
· les légendes des images sont centrées verticalement ; le design en relief est activé par défaut, avec des réglages pour le relief et les contours.

## 184

### ru

Что изменилось в этой сборке:

· новый облик приложения: объёмные карточки и пузыри, полупрозрачные шапка и панели, поле ввода парит над перепиской;
· круглые аватары показывают, кто сейчас в сети; карточка собеседника открывается крупным аватаром;
· четыре новых обоя для бесед: «Сияние», «Волны», «Рельеф» и «Зарисовки»; на новой установке по умолчанию — зелёная тема и «Сияние», уже выбранные тема и обои не меняются;
· сообщение, которое ещё не ушло с телефона, больше не показывает двойную галочку — только часики, пока сервер его не принял;
· двойная галочка «доставлено» появляется сразу, даже если у собеседника открыта другая беседа или список контактов.

### en

What's changed in this build:

· a new look: raised cards and bubbles, translucent header and panels, and a message field that floats above the conversation;
· round avatars show who is online right now; a contact's card opens with a large avatar;
· four new chat wallpapers: Aurora, Waves, Contours and Doodles; a fresh install starts with the green theme and Aurora, while a theme and wallpaper you already chose stay as they are;
· a message that has not left your phone yet no longer shows a double tick — only the hourglass, until the server has it;
· the double "delivered" tick now appears right away, even when the other person has another conversation or the contact list open.

### fr

Ce qui change dans cette version :

· un nouveau look : cartes et bulles en relief, en-tête et panneaux translucides, et un champ de saisie qui flotte au-dessus de la conversation ;
· des avatars ronds montrent qui est en ligne ; la fiche d'un contact s'ouvre avec un grand avatar ;
· quatre nouveaux fonds de conversation : Aurora, Waves, Contours et Doodles ; une nouvelle installation démarre avec le thème vert et Aurora, tandis que le thème et le fond déjà choisis restent inchangés ;
· un message qui n'a pas encore quitté votre téléphone n'affiche plus de double coche — seulement le sablier, jusqu'à ce que le serveur l'ait reçu ;
· la double coche « distribué » apparaît tout de suite, même si votre correspondant a une autre conversation ou la liste des contacts ouverte.

## 183

### ru

Что изменилось в этой сборке:

· при выделении сообщений галочки доставки остаются видны; отдельные галочки выбора убраны;
· выбранные сообщения заметно подсвечиваются акцентным цветом приложения в светлой и тёмной темах;
· нижняя панель действий сохраняет высоту поля ввода — переписка не сдвигается при выборе и отмене.

### en

What's changed in this build:

· delivery marks remain visible while selecting messages; separate selection checks have been removed;
· selected messages use a visible app-accent highlight in both light and dark themes;
· the bottom action bar keeps the input area's height, so selecting and cancelling do not shift the conversation.

### fr

Ce qui change dans cette version :

· les marques de livraison restent visibles pendant la sélection ; les coches de sélection séparées ont été retirées ;
· les messages sélectionnés sont clairement surlignés avec la couleur d'accent de l'application, en thème clair comme sombre ;
· la barre d'actions conserve la hauteur de la zone de saisie : la conversation ne se décale pas lors de la sélection ou de son annulation.

## 182

### ru

Что изменилось в этой сборке:

· галочки отправки и доставки стали ровными и компактными; две галочки накладываются друг на друга, прочитанное по-прежнему отмечается зелёным;
· при выделении сообщений галочки доставки скрываются — остаётся только кружок выбранного сообщения;
· сообщения больше не объединяются в серии: у каждого видны свой автор, время и отметка доставки.

### en

What's changed in this build:

· sent and delivered check marks are now clean and compact; the two checks overlap, and read messages still use green;
· delivery marks disappear while selecting messages, leaving only the selection circle;
· messages are no longer grouped into runs: each shows its own author, time and delivery status.

### fr

Ce qui change dans cette version :

· les coches d'envoi et de livraison sont désormais nettes et compactes ; les deux coches se superposent, et les messages lus restent marqués en vert ;
· les marques de livraison disparaissent pendant la sélection des messages, seul le cercle de sélection reste visible ;
· les messages ne sont plus regroupés en séries : chacun affiche son auteur, son heure et son état de livraison.

## 181

### ru

Что изменилось в этой сборке:

· реакции на сообщение больше не делают его выше — они на той же строке, что и время, и просто раздвигают сообщение в ширину;
· реакции и выделенное сообщение больше не обведены рамкой;
· выделение сообщения срабатывает быстрее и ловится и рядом с сообщением, не только по самому тексту;
· после нажатия на лого анимация больше не повторяется каждый раз при возврате в список бесед.

### en

What's changed in this build:

· reactions on a message no longer make it taller — they sit on the same line as the time and widen the message instead;
· reactions and a selected message no longer have a border;
· selecting a message is faster and also works just beside it, not only on the text itself;
· tapping the logo no longer replays its animation every time you come back to the conversation list.

### fr

Ce qui change dans cette version :

· les réactions à un message ne le rendent plus plus haut — elles se trouvent sur la même ligne que l'heure et élargissent le message à la place ;
· les réactions et un message sélectionné n'ont plus de bordure ;
· la sélection d'un message est plus rapide et fonctionne aussi juste à côté, pas seulement sur le texte ;
· toucher le logo ne rejoue plus son animation à chaque retour à la liste des conversations.

## 180

### ru

Что изменилось в этой сборке:

· исправлена лишняя нагрузка, остававшаяся после завершения или быстрой отмены звонков;
· в веб-версии сообщения выделяются удержанием и протяжкой, а обратная протяжка снимает выделение;
· выделение использует цвет темы; действия с выбранными сообщениями доступны в меню, а пересылка открывает разговор получателя.

### en

What's changed in this build:

· fixed lingering workload after ending calls or cancelling them during setup;
· on the web, hold and drag to select messages, then drag back to deselect;
· selection uses the theme colour; actions for selected messages are in the menu, and forwarding opens the recipient's conversation.

### fr

Ce qui change dans cette version :

· correction de la charge inutile qui persistait après la fin d'un appel ou son annulation pendant la préparation ;
· dans la version web, maintenez puis faites glisser pour sélectionner des messages ; revenez en arrière pour les désélectionner ;
· la sélection utilise la couleur du thème ; les actions sont dans le menu, et le transfert ouvre la conversation du destinataire.

## 179

### ru

Что изменилось в этой сборке:

· сообщения отправляются быстрее, связь стала устойчивее;
· переписка восстанавливается после сбоя загрузки или переподключения;
· сообщения не отмечаются прочитанными, пока приложение или разговор не видны; подтверждённое прочтение сохраняется после перезапуска;
· исправлено падение при закрытии приложения;
· уведомления устойчивее к сбоям и изменению подписки браузера.

### en

What's changed in this build:

· faster message sending and more stable connections;
· conversations recover after a failed load or reconnection;
· messages are not marked read while the app or conversation is hidden; confirmed reads survive a restart;
· fixed a crash when closing the app;
· notifications better withstand outages and browser subscription changes.

### fr

Ce qui change dans cette version :

· envoi des messages plus rapide et connexions plus stables ;
· les conversations se rétablissent après un échec de chargement ou une reconnexion ;
· les messages ne sont pas marqués comme lus quand l'application ou la conversation est masquée ; les lectures confirmées restent enregistrées après un redémarrage ;
· correction d'un plantage à la fermeture de l'application ;
· les notifications résistent mieux aux pannes et aux changements d'abonnement du navigateur.

## 178

### ru

Что нового в этой сборке:

· выделение сообщений: удержите сообщение — включится выделение, дальше сообщения отмечаются обычным нажатием; внизу видно, сколько выбрано, и выбранные можно переслать или удалить разом;
· пока есть выделение, строки удаления в меню сообщения показывают, сколько сообщений будет удалено («Удалить у меня (3)»);
· галочки стали крупнее — отметку «отправлено / доставлено / прочитано» легче разглядеть.

### en

What's new in this build:

· message selection: hold a message to start selecting, then tap the others; the bar shows how many are selected, and the selection can be forwarded or deleted together;
· while a selection exists, the message menu's delete rows say how many messages they will delete (“Delete for me (3)”);
· the ticks are larger — the sent / delivered / read mark is easier to see.

### fr

Quoi de neuf dans cette version :

· sélection de messages : maintenez un message pour commencer la sélection, puis touchez les autres ; la barre indique combien sont sélectionnés, et la sélection peut être transférée ou supprimée en une fois ;
· tant qu'une sélection existe, les lignes de suppression du menu indiquent combien de messages seront supprimés (« Supprimer pour moi (3) ») ;
· les coches sont plus grandes — la marque « envoyé / remis / lu » se lit plus facilement.

## 177

### ru

Что нового в этой сборке:

· галочки показывают три состояния: ✓ — отправлено, ✓✓ — доставлено на устройство собеседника, зелёные ✓✓ — прочитано;
· прочитанное больше не теряется: если связь обрывается ровно в тот момент, когда собеседник читает переписку, отметка всё равно доходит.

### en

What's new in this build:

· the ticks now show three states: ✓ sent, ✓✓ delivered to the other person's device, green ✓✓ read;
· a read is no longer lost: if the connection drops exactly while the other side is reading, the mark still arrives.

### fr

Quoi de neuf dans cette version :

· les coches montrent désormais trois états : ✓ envoyé, ✓✓ remis sur l'appareil de votre correspondant, ✓✓ vert lu ;
· une lecture n'est plus perdue : si la connexion se coupe juste au moment où l'autre personne lit, la coche arrive quand même.

## 176

### ru

Что нового в этой сборке:

· в меню сообщения (долгое нажатие) видно, когда и с какого клиента собеседник прочитал ваше сообщение — например «Прочитано: 14:44 · телефон».

### en

What's new in this build:

· the message menu shows when the other side read your message and from which client — for example “Read: 14:44 · phone”.

### fr

Quoi de neuf dans cette version :

· le menu d'un message indique quand l'autre personne l'a lu et depuis quel client — par exemple « Lu : 14:44 · téléphone » ;

## 175

### ru

Что нового в этой сборке:

· в настройках при переключении мелодий и наборов звуков теперь сразу слышно их превью (звук идёт через медиапоток и не глушится виброрежимом);
· книжная тема (Paper) и шрифт с засечками (Serif) теперь включены по умолчанию и стоят первыми в настройках.

### en

What's new in this build:

· switching ringtones and sound packs in settings now plays an immediate preview over the media stream;
· the Paper theme and Serif font are now enabled by default and listed first in settings.

### fr

Quoi de neuf dans cette version :

· lors du choix des sonneries et des sons dans les paramètres, un aperçu est immédiatement audible via le flux média ;
· le thème Papier et la police Serif sont désormais activés par défaut et placés en tête des paramètres.

## 174

### ru

Что нового в этой сборке:

· поиск в списке диалогов теперь всегда на виду — лупа больше не нужна;
· строка «@логин ● online» — на овальной подложке, как у логотипа, и занимает меньше места;
· счётчик «в сети» внизу считает только людей — служебные аккаунты и боты в него не входят;
· на сообщениях, для которых включено напоминание, рядом с «изменено» виден значок будильника.

### en

What's new in this build:

· the search field in the conversation list is always visible — no magnifier to press;
· the “@login ● online” line sits on an oval pill, like the logo's, and takes less room;
· the “online” counter at the bottom counts people only — service accounts and bots are left out;
· a message with a reminder shows a small alarm mark next to “edited”.

### fr

Quoi de neuf dans cette version :

· le champ de recherche de la liste des conversations est toujours visible — plus besoin de la loupe ;
· la ligne « @identifiant ● online » est sur une pastille ovale, comme le logo, et prend moins de place ;
· le compteur « en ligne » en bas ne compte que les personnes — comptes de service et robots exclus ;
· un message avec un rappel affiche une petite alarme à côté de « modifié ».
