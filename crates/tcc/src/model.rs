//! What `tcc` knows: the roster, the conversations, the receipts. Frames and
//! typed lines go in, [`Effect`]s come out; nothing here touches a socket, a
//! screen or the clock (the clock and the id source are injected).

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};

use crate::media::Media;
use crate::text::{clean, login_of};

/// How many messages a conversation page asks the server for.
pub const HISTORY_LIMIT: u32 = 40;
/// Messages kept per conversation in memory.
const CONV_MAX: usize = 1000;
/// How long a status line stays.
const STATUS_MS: i64 = 8_000;
/// How long "typing…" outlives its last frame.
const TYPING_MS: i64 = 6_000;
/// The server's cap on ids in one `del`.
const DEL_MAX: usize = 200;

pub const HELP: [&str; 11] = [
    "Tab / Shift-Tab, Ctrl-N / Ctrl-P   switch conversation",
    "PgUp / PgDn                        scroll       Alt-Enter  new line",
    "/to <login>        open a conversation",
    "/who               who is around",
    "/edit <text>       change your last message",
    "/del [me] [n]      delete your last n messages (me: only for you)",
    "/react <emoji>     react to the last incoming message (/unreact removes)",
    "/retry             send failed messages again",
    "/img <file> [text] send a picture (JPEG, PNG, GIF, WebP; big ones are shrunk)",
    "/open [n]          open the n-th latest picture of this chat in the viewer",
    "/quit              leave (Ctrl-C too).   //text sends a leading slash",
];

/// The receipt ladder, lowest to highest. A mark never walks backwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Rung {
    /// ⧗ never confirmed by the server.
    Queued,
    /// ✓ the server committed it.
    Sent,
    /// ✓✓ the peer's device holds it.
    Delivered,
    /// ✓✓ in the read colour.
    Read,
}

/// One line of a conversation.
#[derive(Debug, Clone)]
pub struct Msg {
    pub id: String,
    pub mine: bool,
    /// Who spoke when it is not the person or the peer: the AI's name.
    pub author: String,
    pub text: String,
    /// `[image]`, `[voice]`: what the message carries that a terminal cannot.
    pub tags: Vec<&'static str>,
    /// The picture, when the message carries one this client can read.
    pub image: Option<Arc<Media>>,
    pub ts: i64,
    pub rung: Rung,
    /// The server refused it; it will not be sent again by itself.
    pub failed: bool,
    /// A line of this program's own, never sent anywhere.
    pub system: bool,
    pub edited: bool,
    pub reactions: Vec<(String, Vec<String>)>,
}

/// One roster row.
#[derive(Debug, Clone)]
pub struct Contact {
    pub login: String,
    pub name: String,
    pub online: bool,
    pub pending: u64,
    pub last_seen: i64,
    /// `tailchat` and `tailik`: accounts of the deployment, not people.
    pub official: bool,
}

impl Contact {
    pub fn title(&self) -> &str {
        if self.name.is_empty() {
            &self.login
        } else {
            &self.name
        }
    }
}

/// One conversation's transcript and the marks that go with it.
#[derive(Default)]
pub struct Conv {
    pub msgs: Vec<Msg>,
    /// Lines scrolled up from the bottom.
    pub scroll: usize,
    pub max_scroll: usize,
    /// Messages that arrived while scrolled up.
    pub unseen: usize,
    pub typing_until: i64,
    read_ts: i64,
    delivered_ts: i64,
    /// Messages were waiting when it was opened: they are read once shown.
    owes_read: bool,
}

/// The socket as the person should see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkState {
    Connecting,
    Online,
    Offline { retry_at: i64 },
}

/// What the I/O side has to do.
#[derive(Debug, PartialEq)]
pub enum Effect {
    Send(Value),
    History(String),
    Bell,
    Quit,
    Fatal(String),
    /// Show a picture in the system viewer.
    Open(Arc<Media>),
    /// Read a picture from disk and send it (`path` as typed).
    LoadImage {
        peer: String,
        path: String,
        caption: String,
    },
}

pub struct Model {
    pub me: String,
    pub contacts: Vec<Contact>,
    pub convs: HashMap<String, Conv>,
    pub current: Option<String>,
    pub link: LinkState,
    pub status: Option<(String, i64)>,
    pub show_info: bool,
    interactive: bool,
    now: fn() -> i64,
    new_id: fn() -> String,
    /// A conversation with messages shown and not yet reported read.
    read_due: Option<String>,
    seen_ready: bool,
    notes: u64,
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn num_of(value: &Value, key: &str) -> i64 {
    value
        .get(key)
        .and_then(|n| n.as_i64().or_else(|| n.as_u64().and_then(|u| i64::try_from(u).ok())))
        .unwrap_or(0)
}

fn bool_of(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn frame_to(peer: &str, d: &Value) -> Value {
    json!({"k": "frame", "to": peer, "d": d})
}

/// Splits `/img`'s argument into the file, as typed (quotes and `\ ` are left
/// for `media::clean_path`), and the caption after it.
fn split_path(rest: &str) -> (String, String) {
    let rest = rest.trim();
    let Some(first) = rest.chars().next() else {
        return (String::new(), String::new());
    };
    if first == '"' || first == '\'' {
        let quote = first.len_utf8();
        let inner = rest.get(quote..).unwrap_or("");
        if let Some(end) = inner.find(first) {
            let path = rest.get(..quote + end + quote).unwrap_or(rest);
            let caption = inner.get(end + quote..).unwrap_or("").trim();
            return (path.to_owned(), caption.to_owned());
        }
    }
    // Unquoted: the file ends at the first space that is not escaped.
    let mut escaped = false;
    for (at, c) in rest.char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c.is_whitespace() {
            let path = rest.get(..at).unwrap_or(rest);
            let caption = rest.get(at..).unwrap_or("").trim();
            return (path.to_owned(), caption.to_owned());
        }
    }
    (rest.to_owned(), String::new())
}

/// Pictures kept in memory per conversation; older ones give way and are
/// shown as `[image]` from then on.
const MEDIA_BUDGET: usize = 20 * 1024 * 1024;
/// Global media ceiling across all conversations combined (max 24 MB RAM).
const GLOBAL_MEDIA_BUDGET: usize = 24 * 1024 * 1024;

fn trim_media(conv: &mut Conv) {
    let mut total: usize = conv
        .msgs
        .iter()
        .filter_map(|m| m.image.as_ref())
        .map(|image| image.bytes.len())
        .sum();
    for msg in &mut conv.msgs {
        if total <= MEDIA_BUDGET {
            break;
        }
        if msg.mine && msg.rung == Rung::Queued {
            continue;
        }
        if let Some(image) = msg.image.take() {
            total = total.saturating_sub(image.bytes.len());
            if !msg.tags.contains(&"[image]") {
                msg.tags.push("[image]");
            }
        }
    }
}

impl Model {
    /// Trims images across all conversations, pruning inactive chats first.
    /// Keeps overall memory footprint low and predictable (under ~35 MB).
    pub fn trim_global_media(&mut self) {
        let current_peer = self.current.clone();
        let mut total: usize = self
            .convs
            .values()
            .flat_map(|c| &c.msgs)
            .filter_map(|m| m.image.as_ref())
            .map(|img| img.bytes.len())
            .sum();

        if total <= GLOBAL_MEDIA_BUDGET {
            return;
        }

        // Pass 1: Prune images from inactive conversations first
        for (peer, conv) in &mut self.convs {
            if Some(peer) == current_peer.as_ref() {
                continue;
            }
            for msg in &mut conv.msgs {
                if total <= GLOBAL_MEDIA_BUDGET {
                    return;
                }
                if msg.mine && msg.rung == Rung::Queued {
                    continue;
                }
                if let Some(image) = msg.image.take() {
                    total = total.saturating_sub(image.bytes.len());
                    if !msg.tags.contains(&"[image]") {
                        msg.tags.push("[image]");
                    }
                }
            }
        }

        // Pass 2: If still over budget, prune older images from current conversation
        if let Some(cur) = current_peer
            && let Some(conv) = self.convs.get_mut(&cur)
        {
            for msg in &mut conv.msgs {
                if total <= GLOBAL_MEDIA_BUDGET {
                    return;
                }
                if msg.mine && msg.rung == Rung::Queued {
                    continue;
                }
                if let Some(image) = msg.image.take() {
                    total = total.saturating_sub(image.bytes.len());
                    if !msg.tags.contains(&"[image]") {
                        msg.tags.push("[image]");
                    }
                }
            }
        }
    }
}

/// The frame that carries `msg` to `peer`.
fn msg_frame(peer: &str, msg: &Msg) -> Value {
    let mut d = json!({"t": "msg", "id": msg.id, "text": msg.text, "ts": msg.ts});
    if let (Some(image), Some(object)) = (&msg.image, d.as_object_mut()) {
        object.insert("image".to_owned(), image.to_value());
    }
    frame_to(peer, &d)
}

fn upsert(conv: &mut Conv, msg: Msg) {
    if let Some(known) = conv.msgs.iter_mut().find(|m| m.id == msg.id) {
        let rung = known.rung.max(msg.rung);
        *known = Msg { rung, ..msg };
    } else {
        conv.msgs.push(msg);
    }
    conv.msgs.sort_by_key(|m| m.ts);
    if conv.msgs.len() > CONV_MAX {
        let extra = conv.msgs.len() - CONV_MAX;
        conv.msgs.drain(..extra);
    }
    trim_media(conv);
}

fn raise(conv: &mut Conv, id: &str, to: Rung) {
    if let Some(msg) = conv.msgs.iter_mut().find(|m| m.mine && m.id == id)
        && msg.rung < to
    {
        msg.rung = to;
    }
}

/// A watermark is a statement about everything up to it, not one bubble.
fn apply_marks(conv: &mut Conv) {
    let (read, delivered) = (conv.read_ts, conv.delivered_ts);
    for msg in conv.msgs.iter_mut().filter(|m| m.mine && m.rung >= Rung::Sent) {
        if msg.ts <= read {
            msg.rung = msg.rung.max(Rung::Read);
        } else if msg.ts <= delivered {
            msg.rung = msg.rung.max(Rung::Delivered);
        }
    }
}

fn react(conv: &mut Conv, id: &str, emoji: &str, by: &str, add: bool) {
    let Some(msg) = conv.msgs.iter_mut().find(|m| m.id == id) else {
        return;
    };
    let at = msg.reactions.iter().position(|(e, _)| e == emoji);
    match (at, add) {
        (Some(i), true) => {
            if let Some((_, who)) = msg.reactions.get_mut(i)
                && !who.iter().any(|w| w == by)
            {
                who.push(by.to_owned());
            }
        }
        (None, true) => msg.reactions.push((emoji.to_owned(), vec![by.to_owned()])),
        (Some(i), false) => {
            if let Some((_, who)) = msg.reactions.get_mut(i) {
                who.retain(|w| w != by);
                if who.is_empty() {
                    msg.reactions.remove(i);
                }
            }
        }
        (None, false) => {}
    }
}

impl Model {
    pub fn new(
        peer: Option<String>,
        interactive: bool,
        now: fn() -> i64,
        new_id: fn() -> String,
    ) -> Self {
        Self {
            me: String::new(),
            contacts: Vec::new(),
            convs: HashMap::new(),
            current: peer,
            link: LinkState::Connecting,
            status: None,
            show_info: true,
            interactive,
            now,
            new_id,
            read_due: None,
            seen_ready: false,
            notes: 0,
        }
    }

    pub fn now(&self) -> i64 {
        (self.now)()
    }

    pub fn contact(&self, login: &str) -> Option<&Contact> {
        self.contacts.iter().find(|c| c.login == login)
    }

    pub fn title(&self, login: &str) -> String {
        self.contact(login)
            .map_or_else(|| login.to_owned(), |c| clean(c.title()))
    }

    /// People first, then the deployment's own accounts; online before away;
    /// among the away the more recently seen first, by the minute so that a
    /// heartbeat never reshuffles the list; names break every tie.
    pub fn sorted(&self) -> Vec<&Contact> {
        let mut list: Vec<&Contact> = self.contacts.iter().collect();
        list.sort_by_key(|c| {
            let seen = if c.online { 0 } else { -(c.last_seen / 60_000) };
            (c.official, !c.online, seen, c.title().to_lowercase())
        });
        list
    }

    pub fn notice(&mut self, text: impl Into<String>) {
        let until = self.now() + STATUS_MS;
        self.status = Some((text.into(), until));
    }

    /// A line of the program's own in the open conversation (or the status
    /// line when none is open).
    fn say(&mut self, text: &str) {
        let Some(peer) = self.current.clone() else {
            self.notice(text);
            return;
        };
        self.notes += 1;
        let msg = Msg {
            id: format!("sys-{}", self.notes),
            mine: false,
            author: String::new(),
            text: text.to_owned(),
            tags: Vec::new(),
            image: None,
            ts: self.now(),
            rung: Rung::Read,
            failed: false,
            system: true,
            edited: false,
            reactions: Vec::new(),
        };
        let conv = self.convs.entry(peer).or_default();
        upsert(conv, msg);
    }

    pub fn set_link(&mut self, link: LinkState) {
        self.link = link;
    }

    pub fn take_read(&mut self) -> Option<Value> {
        let peer = self.read_due.take()?;
        Some(json!({"k": "mark-read", "peer": peer}))
    }

    pub fn read_pending(&self) -> bool {
        self.read_due.is_some()
    }

    /// Own messages the server has not confirmed (and has not refused).
    pub fn unconfirmed(&self) -> usize {
        self.convs
            .values()
            .flat_map(|c| &c.msgs)
            .filter(|m| m.mine && m.rung == Rung::Queued && !m.failed)
            .count()
    }

    pub fn failed(&self) -> usize {
        self.convs
            .values()
            .flat_map(|c| &c.msgs)
            .filter(|m| m.mine && m.failed)
            .count()
    }

    fn conv_mut(&mut self, peer: &str) -> &mut Conv {
        self.convs.entry(peer.to_owned()).or_default()
    }

    // ── incoming ───────────────────────────────────────────────────────────

    pub fn on_server(&mut self, frame: &Value) -> Vec<Effect> {
        match str_of(frame, "k") {
            "ready" => self.on_ready(frame),
            "users" => {
                self.set_contacts(frame.get("users"), true);
                Vec::new()
            }
            "subscribed" | "presence" => {
                let peer = str_of(frame, "peer").to_owned();
                if let Some(c) = self.contacts.iter_mut().find(|c| c.login == peer) {
                    c.online = bool_of(frame, "online");
                }
                Vec::new()
            }
            "frame" => self.on_inner(frame),
            "message-accepted" => {
                self.on_accepted(frame);
                Vec::new()
            }
            "unread" => {
                let from = str_of(frame, "from").to_owned();
                if let Some(count) = frame.get("count").and_then(Value::as_u64)
                    && self.current.as_deref() != Some(from.as_str())
                    && let Some(c) = self.contacts.iter_mut().find(|c| c.login == from)
                {
                    c.pending = count;
                }
                if self.current.as_deref() == Some(from.as_str()) {
                    Vec::new()
                } else {
                    vec![Effect::Bell]
                }
            }
            // This account read it on another device.
            "read-sync" => {
                let peer = str_of(frame, "peer").to_owned();
                if let Some(c) = self.contacts.iter_mut().find(|c| c.login == peer) {
                    c.pending = 0;
                }
                Vec::new()
            }
            "react-sync" => {
                let peer = str_of(frame, "peer").to_owned();
                let add = frame.get("add").and_then(Value::as_bool) != Some(false);
                let (id, emoji, by) = (
                    str_of(frame, "id"),
                    str_of(frame, "emoji"),
                    str_of(frame, "by"),
                );
                react(self.conv_mut(&peer), id, emoji, by, add);
                Vec::new()
            }
            "throttle" => {
                self.notice("the server is throttling this client: slow down");
                Vec::new()
            }
            "error" => self.on_error(frame),
            _ => Vec::new(), // a newer server may say more than this client knows
        }
    }

    fn on_ready(&mut self, frame: &Value) -> Vec<Effect> {
        self.link = LinkState::Online;
        self.me = frame
            .get("self")
            .map_or("", |me| str_of(me, "login"))
            .to_owned();
        self.seen_ready = true;
        self.set_contacts(frame.get("users"), false);
        let mut effects = Vec::new();
        if self.interactive {
            if let Some(cur) = self.current.clone()
                && self.contact(&cur).is_none()
            {
                self.notice(format!("no such contact: @{cur}"));
                self.current = None;
            }
            if self.current.is_none() {
                let pick = {
                    let sorted = self.sorted();
                    sorted
                        .iter()
                        .find(|c| c.pending > 0)
                        .or_else(|| sorted.first())
                        .map(|c| c.login.clone())
                };
                self.current = pick;
            }
            if let Some(cur) = self.current.clone() {
                effects.extend(self.open(&cur));
            }
        }
        effects.extend(self.resend());
        effects
    }

    fn set_contacts(&mut self, list: Option<&Value>, reading: bool) {
        let Some(items) = list.and_then(Value::as_array) else {
            return;
        };
        self.contacts = items
            .iter()
            .filter(|item| !str_of(item, "login").is_empty())
            .map(|item| Contact {
                login: str_of(item, "login").to_owned(),
                name: item
                    .get("alias")
                    .and_then(Value::as_str)
                    .filter(|alias| !alias.is_empty())
                    .unwrap_or_else(|| str_of(item, "name"))
                    .to_owned(),
                online: bool_of(item, "online"),
                pending: item.get("pending").and_then(Value::as_u64).unwrap_or(0),
                last_seen: num_of(item, "lastSeen"),
                official: bool_of(item, "official"),
            })
            .collect();
        // What is being read is not unread; the server is told shortly. (On
        // `ready` the open conversation is about to be reloaded, and `open`
        // owes the read once its messages are actually on screen.)
        if reading
            && let Some(cur) = self.current.clone()
            && let Some(c) = self.contacts.iter_mut().find(|c| c.login == cur)
            && c.pending > 0
        {
            c.pending = 0;
            self.read_due = Some(cur);
        }
    }

    /// Opens a conversation: subscribe, load its page, owe the server a read.
    fn open(&mut self, peer: &str) -> Vec<Effect> {
        self.current = Some(peer.to_owned());
        self.trim_global_media();
        let waiting = self.contact(peer).is_some_and(|c| c.pending > 0);
        if let Some(c) = self.contacts.iter_mut().find(|c| c.login == peer) {
            c.pending = 0;
        }
        let conv = self.conv_mut(peer);
        conv.scroll = 0;
        conv.unseen = 0;
        conv.owes_read = waiting;
        vec![
            Effect::Send(json!({"k": "subscribe", "peer": peer})),
            Effect::History(peer.to_owned()),
        ]
    }

    pub fn select(&mut self, login: &str) -> Vec<Effect> {
        if self.current.as_deref() == Some(login) {
            return Vec::new();
        }
        self.open(login)
    }

    /// Previous (`-1`) or next (`1`) conversation in roster order.
    pub fn cycle(&mut self, delta: isize) -> Vec<Effect> {
        let logins: Vec<String> = self.sorted().iter().map(|c| c.login.clone()).collect();
        if logins.is_empty() {
            return Vec::new();
        }
        let at = self
            .current
            .as_ref()
            .and_then(|cur| logins.iter().position(|l| l == cur))
            .and_then(|i| isize::try_from(i).ok());
        let len = isize::try_from(logins.len()).unwrap_or(1);
        let next = match at {
            Some(i) => (i + delta).rem_euclid(len),
            None => 0,
        };
        let Some(login) = usize::try_from(next).ok().and_then(|i| logins.get(i)) else {
            return Vec::new();
        };
        self.select(login)
    }

    pub fn on_history(&mut self, peer: &str, body: Result<Value, String>) {
        let page = match body {
            Ok(page) => page,
            Err(reason) => {
                self.notice(format!("history: {reason}"));
                return;
            }
        };
        let records: Vec<Value> = page
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let msgs: Vec<Msg> = records
            .iter()
            .filter_map(|rec| {
                let from = str_of(rec, "from");
                let ai = str_of(rec, "kind") == "ai";
                let author = match str_of(rec, "author") {
                    "" => self.title(from),
                    name => name.to_owned(),
                };
                self.make_msg(rec, from, ai, &author)
            })
            .collect();
        let current = self.current.as_deref() == Some(peer);
        let mut owed = false;
        let conv = self.conv_mut(peer);
        conv.read_ts = conv.read_ts.max(num_of(&page, "peerReadTs"));
        conv.delivered_ts = conv.delivered_ts.max(num_of(&page, "peerDeliveredTs"));
        for msg in msgs {
            upsert(conv, msg);
        }
        apply_marks(conv);
        if current && conv.owes_read {
            conv.owes_read = false;
            owed = true;
        }
        if owed {
            self.read_due = Some(peer.to_owned());
        }
        self.trim_global_media();
    }

    /// A message from a frame or a history record. `from` is its author's login.
    fn make_msg(&self, d: &Value, from: &str, ai: bool, author: &str) -> Option<Msg> {
        let id = str_of(d, "id");
        if id.is_empty() {
            return None;
        }
        let text = clean(str_of(d, "text"));
        let mut tags = Vec::new();
        let mut image = None;
        if let Some(value) = d.get("image") {
            match Media::from_value(value) {
                Some(media) => image = Some(Arc::new(media)),
                None => tags.push("[image]"), // no data left, or one this client cannot read
            }
        }
        if d.get("voice").is_some() {
            tags.push("[voice]");
        }
        if text.is_empty() && tags.is_empty() && image.is_none() && d.get("e2ee").is_some() {
            tags.push("[encrypted: tcc cannot read this]");
        }
        let mine = !ai && from == self.me;
        let ts = match num_of(d, "ts") {
            0 => self.now(),
            ts => ts,
        };
        let reactions = d
            .get("reactions")
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .map(|(emoji, who)| {
                        let who = who
                            .as_array()
                            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                            .unwrap_or_default();
                        (emoji.clone(), who)
                    })
                    .filter(|(_, who): &(String, Vec<String>)| !who.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        Some(Msg {
            id: id.to_owned(),
            mine,
            author: clean(author),
            text,
            tags,
            image,
            ts,
            rung: if mine { Rung::Sent } else { Rung::Read },
            failed: false,
            system: false,
            edited: d.get("editedAt").is_some(),
            reactions,
        })
    }

    fn on_accepted(&mut self, frame: &Value) {
        let id = str_of(frame, "id").to_owned();
        let ts = num_of(frame, "ts");
        let peer = str_of(frame, "peer").to_owned();
        let keys: Vec<String> = if peer.is_empty() {
            self.convs.keys().cloned().collect()
        } else {
            vec![peer]
        };
        for key in keys {
            let conv = self.conv_mut(&key);
            let Some(msg) = conv.msgs.iter_mut().find(|m| m.mine && m.id == id) else {
                continue;
            };
            msg.rung = msg.rung.max(Rung::Sent);
            msg.failed = false;
            if ts > 0 {
                msg.ts = ts; // the shared clock decides the order
            }
            conv.msgs.sort_by_key(|m| m.ts);
            apply_marks(conv);
        }
    }

    fn on_inner(&mut self, frame: &Value) -> Vec<Effect> {
        let Some(d) = frame.get("d") else {
            return Vec::new();
        };
        // The conversation is named by `from` for the peer's frames and for
        // this account's own other devices alike.
        let key = str_of(frame, "from").to_owned();
        let echo = bool_of(frame, "self");
        let kind = str_of(d, "t");
        match kind {
            "msg" | "ai" => self.on_message(&key, d, echo, kind == "ai"),
            "ack" | "read" if !echo => {
                let id = str_of(d, "id").to_owned();
                let delivered = num_of(d, "deliveredTs");
                let read = num_of(d, "readTs");
                let conv = self.conv_mut(&key);
                conv.delivered_ts = conv.delivered_ts.max(delivered);
                conv.read_ts = conv.read_ts.max(read);
                raise(conv, &id, if kind == "ack" { Rung::Delivered } else { Rung::Read });
                apply_marks(conv);
                Vec::new()
            }
            "edit" => {
                let (id, text) = (str_of(d, "id"), clean(str_of(d, "text")));
                if let Some(msg) = self.conv_mut(&key).msgs.iter_mut().find(|m| m.id == id) {
                    msg.text = text;
                    msg.edited = true;
                }
                Vec::new()
            }
            "del" => {
                let mut ids: Vec<&str> = d
                    .get("ids")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                ids.push(str_of(d, "id"));
                self.conv_mut(&key).msgs.retain(|m| !ids.contains(&m.id.as_str()));
                Vec::new()
            }
            "react" => {
                let add = d.get("add").and_then(Value::as_bool) != Some(false);
                react(
                    self.conv_mut(&key),
                    str_of(d, "id"),
                    str_of(d, "emoji"),
                    str_of(d, "by"),
                    add,
                );
                Vec::new()
            }
            "typing" if !echo => {
                let until = if str_of(d, "state") == "start" {
                    self.now() + TYPING_MS
                } else {
                    0
                };
                self.conv_mut(&key).typing_until = until;
                Vec::new()
            }
            _ => Vec::new(), // focus, hello, caps, …: nothing to show
        }
    }

    fn on_message(&mut self, key: &str, d: &Value, echo: bool, ai: bool) -> Vec<Effect> {
        let author_login = if echo && !ai { self.me.clone() } else { key.to_owned() };
        let author = if ai {
            match str_of(d, "name") {
                "" => "tailik".to_owned(),
                name => name.to_owned(),
            }
        } else {
            self.title(&author_login)
        };
        let Some(msg) = self.make_msg(d, &author_login, ai, &author) else {
            return Vec::new();
        };
        let incoming = !msg.mine;
        let viewing = self.current.as_deref() == Some(key);
        let conv = self.conv_mut(key);
        let fresh = !conv.msgs.iter().any(|m| m.id == msg.id);
        upsert(conv, msg);
        if !fresh || !incoming {
            return Vec::new(); // an echo of this account's own words: nothing owed
        }
        conv.typing_until = 0;
        if viewing {
            if conv.scroll > 0 {
                conv.unseen += 1;
            }
            self.read_due = Some(key.to_owned());
            return Vec::new();
        }
        if let Some(c) = self.contacts.iter_mut().find(|c| c.login == key) {
            c.pending += 1;
        }
        vec![Effect::Bell]
    }

    fn on_error(&mut self, frame: &Value) -> Vec<Effect> {
        let code = str_of(frame, "code");
        let message = clean(str_of(frame, "message"));
        match code {
            "auth_failed" | "auth_required" => vec![Effect::Fatal(
                "the server rejected the token: run `tcc login`".to_owned(),
            )],
            "peer_not_found" => {
                self.notice("no such contact");
                Vec::new()
            }
            "not_subscribed" => {
                self.notice("that is not one of your contacts");
                self.fail_last();
                Vec::new()
            }
            "blocked" | "frame_too_large" | "store_failed" | "message_id_conflict" => {
                self.notice(if message.is_empty() { code.to_owned() } else { message });
                self.fail_last();
                Vec::new()
            }
            _ if message.is_empty() => {
                self.notice(code);
                Vec::new()
            }
            _ => {
                self.notice(format!("{code}: {message}"));
                Vec::new()
            }
        }
    }

    /// The newest message still waiting for the server is the one it refused.
    fn fail_last(&mut self) {
        let target = self
            .current
            .iter()
            .chain(self.convs.keys())
            .find_map(|peer| {
                let conv = self.convs.get(peer)?;
                conv.msgs
                    .iter()
                    .rposition(|m| m.mine && m.rung == Rung::Queued && !m.failed)
                    .map(|at| (peer.clone(), at))
            });
        if let Some((peer, at)) = target
            && let Some(msg) = self.conv_mut(&peer).msgs.get_mut(at)
        {
            msg.failed = true;
        }
    }

    /// Everything still queued goes out again after a reconnect; the server
    /// answers a repeated id with the same acceptance, so this is safe.
    fn resend(&self) -> Vec<Effect> {
        let mut frames: Vec<(i64, Effect)> = Vec::new();
        for (peer, conv) in &self.convs {
            for m in conv
                .msgs
                .iter()
                .filter(|m| m.mine && !m.system && m.rung == Rung::Queued && !m.failed)
            {
                frames.push((m.ts, Effect::Send(msg_frame(peer, m))));
            }
        }
        frames.sort_by_key(|(ts, _)| *ts);
        frames.into_iter().map(|(_, effect)| effect).collect()
    }

    // ── outgoing ───────────────────────────────────────────────────────────

    /// A message to `peer`, written down at once and sent when there is a link.
    pub fn send_text(&mut self, peer: &str, text: &str) -> Vec<Effect> {
        self.queue(peer, text, None)
    }

    /// A picture (with a caption, maybe) to `peer`, the same way.
    pub fn send_image(&mut self, peer: &str, media: Media, caption: &str) -> Vec<Effect> {
        self.queue(peer, caption, Some(Arc::new(media)))
    }

    fn queue(&mut self, peer: &str, text: &str, image: Option<Arc<Media>>) -> Vec<Effect> {
        let id = (self.new_id)();
        let ts = self.now();
        let msg = Msg {
            id,
            mine: true,
            author: String::new(),
            text: text.to_owned(),
            tags: Vec::new(),
            image,
            ts,
            rung: Rung::Queued,
            failed: false,
            system: false,
            edited: false,
            reactions: Vec::new(),
        };
        let frame = msg_frame(peer, &msg);
        let conv = self.conv_mut(peer);
        conv.scroll = 0;
        conv.unseen = 0;
        upsert(conv, msg);
        vec![Effect::Send(frame)]
    }

    /// One line typed by the person: a command or a message.
    pub fn submit(&mut self, line: &str) -> Vec<Effect> {
        let text = line.trim_end();
        let command = text.trim();
        if command.is_empty() {
            return Vec::new();
        }
        let (word, rest) = command
            .split_once(char::is_whitespace)
            .map_or((command, ""), |(w, r)| (w, r.trim()));
        let text = if command.starts_with("//") {
            text.strip_prefix('/').unwrap_or(text) // `//text` writes a leading slash
        } else if command.starts_with('/') {
            return self.command(word, rest);
        } else {
            text
        };
        let Some(peer) = self.current.clone() else {
            self.notice("no conversation open: Tab, or /to <login>");
            return Vec::new();
        };
        self.send_text(&peer, text)
    }

    fn command(&mut self, word: &str, rest: &str) -> Vec<Effect> {
        match word {
            "/quit" | "/q" | "/exit" => vec![Effect::Quit],
            "/help" | "/?" => {
                for line in HELP {
                    self.say(line);
                }
                Vec::new()
            }
            "/who" => {
                let lines: Vec<String> = self
                    .sorted()
                    .iter()
                    .map(|c| {
                        let lamp = if c.online { "● online" } else { "○ away" };
                        format!("@{} {lamp}", c.login)
                    })
                    .collect();
                self.say(&lines.join(" · "));
                Vec::new()
            }
            "/to" => {
                let login = login_of(rest);
                if login.is_empty() {
                    self.notice("usage: /to <login>");
                    return Vec::new();
                }
                if self.contact(&login).is_none() {
                    self.notice(format!("no such contact: @{login}"));
                    return Vec::new();
                }
                self.select(&login)
            }
            "/edit" => self.edit_last(rest),
            "/del" => self.delete_last(rest),
            "/react" | "/unreact" => self.react_last(rest, word == "/react"),
            "/retry" => self.retry(),
            "/open" => self.open_image(rest),
            "/img" | "/image" => self.image_command(rest),
            "/info" | "/panel" => {
                self.show_info = !self.show_info;
                let state = if self.show_info { "shown" } else { "hidden" };
                self.notice(format!("info panel {state}"));
                Vec::new()
            }
            "/clear" => {
                if let Some(peer) = self.current.as_ref()
                    && let Some(conv) = self.convs.get_mut(peer)
                {
                    conv.scroll = 0;
                }
                self.status = None;
                Vec::new()
            }
            _ => {
                self.notice(format!("unknown command {word}. /help"));
                Vec::new()
            }
        }
    }

    /// The conversation's last own message the server holds.
    fn last_own(&self) -> Option<(String, String)> {
        let peer = self.current.clone()?;
        let msg = self
            .convs
            .get(&peer)?
            .msgs
            .iter()
            .rfind(|m| m.mine && !m.system && m.rung >= Rung::Sent)?;
        Some((peer, msg.id.clone()))
    }

    fn edit_last(&mut self, text: &str) -> Vec<Effect> {
        if text.is_empty() {
            self.notice("usage: /edit <new text>");
            return Vec::new();
        }
        let Some((peer, id)) = self.last_own() else {
            self.notice("nothing of yours to edit");
            return Vec::new();
        };
        if let Some(msg) = self.conv_mut(&peer).msgs.iter_mut().find(|m| m.id == id) {
            msg.text = text.to_owned();
            msg.edited = true;
        }
        vec![Effect::Send(frame_to(&peer, &json!({"t": "edit", "id": id, "text": text})))]
    }

    fn delete_last(&mut self, args: &str) -> Vec<Effect> {
        let mut words = args.split_whitespace().peekable();
        let own_only = words.next_if(|w| matches!(*w, "me" | "self")).is_some();
        let count = match words.next() {
            None => 1,
            Some(w) => match w.parse::<usize>() {
                Ok(n) if (1..=DEL_MAX).contains(&n) => n,
                _ => {
                    self.notice(format!("usage: /del [me] [1-{DEL_MAX}]"));
                    return Vec::new();
                }
            },
        };
        let Some(peer) = self.current.clone() else {
            return Vec::new();
        };
        let conv = self.conv_mut(&peer);
        let ids: Vec<String> = conv
            .msgs
            .iter()
            .rev()
            .filter(|m| m.mine && !m.system)
            .take(count)
            .map(|m| m.id.clone())
            .collect();
        if ids.is_empty() {
            self.notice("nothing of yours to delete");
            return Vec::new();
        }
        conv.msgs.retain(|m| !ids.contains(&m.id));
        let scope = if own_only { "self" } else { "all" };
        vec![Effect::Send(frame_to(
            &peer,
            &json!({"t": "del", "ids": ids, "scope": scope}),
        ))]
    }

    fn react_last(&mut self, emoji: &str, add: bool) -> Vec<Effect> {
        let emoji = emoji.trim();
        let Some(peer) = self.current.clone() else {
            return Vec::new();
        };
        if emoji.is_empty() {
            self.notice("usage: /react <emoji>");
            return Vec::new();
        }
        let me = self.me.clone();
        let conv = self.conv_mut(&peer);
        let Some(id) = conv
            .msgs
            .iter()
            .rfind(|m| !m.mine && !m.system)
            .map(|m| m.id.clone())
        else {
            self.notice("nothing to react to");
            return Vec::new();
        };
        react(conv, &id, emoji, &me, add);
        let d = json!({"t": "react", "id": id, "emoji": emoji, "by": me, "add": add});
        vec![Effect::Send(frame_to(&peer, &d))]
    }

    fn retry(&mut self) -> Vec<Effect> {
        let Some(peer) = self.current.clone() else {
            return Vec::new();
        };
        let conv = self.conv_mut(&peer);
        let mut effects = Vec::new();
        for m in conv.msgs.iter_mut().filter(|m| m.mine && m.failed) {
            m.failed = false;
            effects.push(Effect::Send(msg_frame(&peer, m)));
        }
        if effects.is_empty() {
            self.notice("nothing to retry");
        }
        effects
    }

    /// `/open [n]`: the n-th latest picture of the open conversation.
    fn open_image(&mut self, arg: &str) -> Vec<Effect> {
        let n = if arg.is_empty() {
            1
        } else {
            match arg.parse::<usize>() {
                Ok(n) if n >= 1 => n,
                _ => {
                    self.notice("usage: /open [n]");
                    return Vec::new();
                }
            }
        };
        let Some(peer) = self.current.clone() else {
            return Vec::new();
        };
        let found = self.convs.get(&peer).and_then(|conv| {
            conv.msgs
                .iter()
                .rev()
                .filter_map(|m| m.image.clone())
                .nth(n.saturating_sub(1))
        });
        if let Some(media) = found {
            vec![Effect::Open(media)]
        } else {
            self.notice("no picture to open here");
            Vec::new()
        }
    }

    /// `/img <file> [caption]`: the file may be quoted, or have `\ ` escapes.
    fn image_command(&mut self, rest: &str) -> Vec<Effect> {
        let (path, caption) = split_path(rest);
        if path.is_empty() {
            self.notice("usage: /img <file> [caption]");
            return Vec::new();
        }
        let Some(peer) = self.current.clone() else {
            self.notice("no conversation open: Tab, or /to <login>");
            return Vec::new();
        };
        vec![Effect::LoadImage { peer, path, caption }]
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    fn next_id() -> String {
        static N: AtomicU64 = AtomicU64::new(1);
        format!("m-{}", N.fetch_add(1, Ordering::Relaxed))
    }

    fn model(peer: Option<&str>) -> Model {
        Model::new(peer.map(str::to_owned), true, || 1_000_000, next_id)
    }

    fn ready_frame() -> Value {
        json!({
            "k": "ready",
            "self": {"login": "alice"},
            "users": [
                {"login": "carol", "name": "Carol", "online": false, "lastSeen": 600_000, "pending": 0},
                {"login": "bob", "name": "Bob", "online": true, "pending": 2},
                {"login": "tailchat", "name": "Tailchat", "online": true, "official": true},
                {"login": "dave", "name": "Dave", "online": false, "lastSeen": 900_000, "alias": "Davie"},
            ],
        })
    }

    fn ready(model: &mut Model) -> Vec<Effect> {
        model.on_server(&ready_frame())
    }

    fn sent_frame(effects: &[Effect]) -> &Value {
        effects
            .iter()
            .find_map(|e| match e {
                Effect::Send(v) => Some(v),
                _ => None,
            })
            .expect("a frame")
    }

    fn conv<'a>(model: &'a Model, peer: &str) -> &'a Conv {
        model.convs.get(peer).expect("conversation")
    }

    #[test]
    fn roster_puts_people_first_then_online_then_recent() {
        let mut m = model(None);
        ready(&mut m);
        let order: Vec<&str> = m.sorted().iter().map(|c| c.login.as_str()).collect();
        assert_eq!(order, ["bob", "dave", "carol", "tailchat"]);
        assert_eq!(m.title("dave"), "Davie", "the alias outranks the name");
    }

    #[test]
    fn ready_opens_the_first_unread_conversation() {
        let mut m = model(None);
        let effects = ready(&mut m);
        assert_eq!(m.current.as_deref(), Some("bob"));
        assert!(effects.contains(&Effect::Send(json!({"k": "subscribe", "peer": "bob"}))));
        assert!(effects.contains(&Effect::History("bob".to_owned())));
        assert_eq!(m.contact("bob").map(|c| c.pending), Some(0));
    }

    #[test]
    fn ready_for_an_unknown_peer_says_so_and_falls_back() {
        let mut m = model(Some("ghost"));
        ready(&mut m);
        assert_eq!(m.current.as_deref(), Some("bob"));
        assert!(m.status.as_ref().is_some_and(|(s, _)| s.contains("@ghost")));
    }

    #[test]
    fn a_message_climbs_the_ladder_by_id_and_by_watermark() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        let effects = m.submit("hello");
        let frame = sent_frame(&effects).clone();
        assert_eq!(frame["to"], "bob");
        assert_eq!(frame["d"]["text"], "hello");
        let id = frame["d"]["id"].as_str().expect("id").to_owned();
        assert_eq!(conv(&m, "bob").msgs[0].rung, Rung::Queued);
        assert_eq!(m.unconfirmed(), 1);

        m.on_server(&json!({"k": "message-accepted", "peer": "bob", "id": id, "ts": 1_000_500}));
        assert_eq!(conv(&m, "bob").msgs[0].rung, Rung::Sent);
        assert_eq!(conv(&m, "bob").msgs[0].ts, 1_000_500, "the server's clock wins");
        assert_eq!(m.unconfirmed(), 0);

        let ack = json!({"k": "frame", "from": "bob", "d": {"t": "ack", "id": id, "deliveredTs": 1_000_500}});
        m.on_server(&ack);
        assert_eq!(conv(&m, "bob").msgs[0].rung, Rung::Delivered);

        // A read watermark lifts every message up to it, not only the named one.
        let second = m.submit("again");
        let second_id = sent_frame(&second)["d"]["id"].as_str().expect("id").to_owned();
        m.on_server(&json!({"k": "message-accepted", "peer": "bob", "id": second_id, "ts": 1_000_600}));
        let read = json!({"k": "frame", "from": "bob", "d": {"t": "read", "id": second_id, "readTs": 1_000_600}});
        m.on_server(&read);
        assert!(conv(&m, "bob").msgs.iter().all(|x| x.rung == Rung::Read));

        // Never backwards.
        m.on_server(&ack);
        assert!(conv(&m, "bob").msgs.iter().all(|x| x.rung == Rung::Read));
    }

    #[test]
    fn history_merges_by_id_and_restores_marks_from_watermarks() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        let live = json!({"k": "frame", "from": "bob", "d": {"t": "msg", "id": "b1", "text": "yo", "ts": 900}});
        m.on_server(&live);
        m.on_history(
            "bob",
            Ok(json!({
                "messages": [
                    {"id": "b1", "from": "bob", "text": "yo", "ts": 900, "kind": "human"},
                    {"id": "a1", "from": "alice", "text": "hi", "ts": 800, "kind": "human"},
                    {"id": "a2", "from": "alice", "text": "later", "ts": 950, "kind": "human"},
                    {"id": "t1", "from": "bob", "text": "hey", "ts": 970, "kind": "ai", "author": "tailik"},
                ],
                "peerReadTs": 800,
                "peerDeliveredTs": 950,
            })),
        );
        let msgs = &conv(&m, "bob").msgs;
        let ids: Vec<&str> = msgs.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["a1", "b1", "a2", "t1"], "one b1, in time order");
        assert_eq!(msgs[0].rung, Rung::Read);
        assert_eq!(msgs[2].rung, Rung::Delivered);
        assert!(!msgs[3].mine && msgs[3].author == "tailik");
    }

    #[test]
    fn incoming_in_the_open_conversation_owes_a_read_elsewhere_a_badge() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        let here = json!({"k": "frame", "from": "bob", "d": {"t": "msg", "id": "x1", "text": "hi\u{1b}[2J"}});
        assert!(m.on_server(&here).is_empty());
        assert_eq!(conv(&m, "bob").msgs[0].text, "hi\u{fffd}[2J");
        assert_eq!(m.take_read(), Some(json!({"k": "mark-read", "peer": "bob"})));
        assert_eq!(m.take_read(), None);

        let elsewhere = json!({"k": "frame", "from": "carol", "d": {"t": "msg", "id": "c1", "text": "psst"}});
        assert_eq!(m.on_server(&elsewhere), [Effect::Bell]);
        assert_eq!(m.contact("carol").map(|c| c.pending), Some(1));
        assert_eq!(m.take_read(), None);
        // The same message again is not a second badge.
        m.on_server(&elsewhere);
        assert_eq!(m.contact("carol").map(|c| c.pending), Some(1));
    }

    #[test]
    fn edits_deletes_and_reactions_from_the_peer_land_on_the_message() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        for (id, text) in [("b1", "one"), ("b2", "two"), ("b3", "three")] {
            m.on_server(&json!({"k": "frame", "from": "bob", "d": {"t": "msg", "id": id, "text": text}}));
        }
        m.on_server(&json!({"k": "frame", "from": "bob", "d": {"t": "edit", "id": "b1", "text": "ONE"}}));
        m.on_server(&json!({"k": "frame", "from": "bob", "d": {"t": "del", "ids": ["b2"]}}));
        m.on_server(&json!({"k": "frame", "from": "bob", "d": {"t": "react", "id": "b3", "emoji": "👍", "by": "bob", "add": true}}));
        let msgs = &conv(&m, "bob").msgs;
        assert_eq!(msgs.len(), 2);
        assert!(msgs[0].edited && msgs[0].text == "ONE");
        assert_eq!(msgs[1].reactions, [("👍".to_owned(), vec!["bob".to_owned()])]);
        m.on_server(&json!({"k": "frame", "from": "bob", "d": {"t": "react", "id": "b3", "emoji": "👍", "by": "bob", "add": false}}));
        assert!(conv(&m, "bob").msgs[1].reactions.is_empty());
    }

    #[test]
    fn typing_shows_until_it_expires_or_the_message_arrives() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        m.on_server(&json!({"k": "frame", "from": "bob", "d": {"t": "typing", "state": "start"}}));
        assert!(conv(&m, "bob").typing_until > m.now());
        m.on_server(&json!({"k": "frame", "from": "bob", "d": {"t": "msg", "id": "t1", "text": "done"}}));
        assert_eq!(conv(&m, "bob").typing_until, 0);
    }

    #[test]
    fn commands_edit_delete_react_and_retry_send_the_right_frames() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        let sent = m.submit("first");
        let id = sent_frame(&sent)["d"]["id"].as_str().expect("id").to_owned();
        // Nothing the server holds yet: nothing to edit.
        assert!(m.submit("/edit nope").is_empty());
        m.on_server(&json!({"k": "message-accepted", "peer": "bob", "id": id}));

        let edit = m.submit("/edit fixed");
        assert_eq!(sent_frame(&edit)["d"], json!({"t": "edit", "id": id, "text": "fixed"}));
        assert_eq!(conv(&m, "bob").msgs[0].text, "fixed");

        m.on_server(&json!({"k": "frame", "from": "bob", "d": {"t": "msg", "id": "b1", "text": "hey"}}));
        let reaction = m.submit("/react 👍");
        assert_eq!(
            sent_frame(&reaction)["d"],
            json!({"t": "react", "id": "b1", "emoji": "👍", "by": "alice", "add": true})
        );

        let del = m.submit("/del me");
        assert_eq!(sent_frame(&del)["d"], json!({"t": "del", "ids": [id], "scope": "self"}));
        assert!(conv(&m, "bob").msgs.iter().all(|x| !x.mine));
        assert!(m.submit("/del 0").is_empty());

        let queued = m.submit("refused");
        let refused = sent_frame(&queued)["d"]["id"].as_str().expect("id").to_owned();
        m.on_server(&json!({"k": "error", "code": "blocked", "message": "blocked"}));
        assert_eq!(m.failed(), 1);
        assert_eq!(m.unconfirmed(), 0, "a refused message is not waiting");
        let retry = m.submit("/retry");
        assert_eq!(sent_frame(&retry)["d"]["id"], refused);
        assert_eq!(m.failed(), 0);
    }

    #[test]
    fn lines_are_commands_or_messages() {
        let mut m = model(None);
        assert!(m.submit("hi").is_empty(), "no conversation open yet");
        assert!(m.status.as_ref().is_some_and(|(s, _)| s.contains("no conversation")));
        ready(&mut m);
        assert!(m.submit("   ").is_empty());
        assert_eq!(m.submit("/quit"), [Effect::Quit]);
        assert!(m.submit("/nope").is_empty());
        assert!(m.status.as_ref().is_some_and(|(s, _)| s.contains("/nope")));
        let escaped = m.submit("//shrug");
        assert_eq!(sent_frame(&escaped)["d"]["text"], "/shrug");
        let to = m.submit("/to @Carol");
        assert_eq!(m.current.as_deref(), Some("carol"));
        assert!(to.contains(&Effect::History("carol".to_owned())));
        assert!(m.submit("/to ghost").is_empty());
        assert_eq!(m.current.as_deref(), Some("carol"));
    }

    #[test]
    fn cycling_walks_the_roster_and_wraps() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        m.cycle(1);
        assert_eq!(m.current.as_deref(), Some("dave"));
        m.cycle(-1);
        m.cycle(-1);
        assert_eq!(m.current.as_deref(), Some("tailchat"));
        m.cycle(1);
        assert_eq!(m.current.as_deref(), Some("bob"));
    }

    #[test]
    fn a_reconnect_sends_what_was_never_confirmed_again() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        let first = m.submit("one");
        let first_id = sent_frame(&first)["d"]["id"].as_str().expect("id").to_owned();
        m.submit("two");
        m.on_server(&json!({"k": "message-accepted", "peer": "bob", "id": first_id}));
        m.set_link(LinkState::Offline { retry_at: 5 });
        let effects = ready(&mut m);
        let resent: Vec<&str> = effects
            .iter()
            .filter_map(|e| match e {
                Effect::Send(v) if v["k"] == "frame" => v["d"]["text"].as_str(),
                _ => None,
            })
            .collect();
        assert_eq!(resent, ["two"]);
        assert_eq!(m.link, LinkState::Online);
    }

    #[test]
    fn errors_stop_only_what_they_must() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        let fatal = m.on_server(&json!({"k": "error", "code": "auth_failed"}));
        assert!(matches!(&fatal[..], [Effect::Fatal(_)]));
        assert!(m.on_server(&json!({"k": "error", "code": "weird", "message": "no"})).is_empty());
        assert!(m.status.as_ref().is_some_and(|(s, _)| s == "weird: no"));
    }

    #[test]
    fn the_unread_count_and_other_devices_keep_the_badges_honest() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        m.on_server(&json!({"k": "unread", "from": "carol", "text": "x", "count": 4}));
        assert_eq!(m.contact("carol").map(|c| c.pending), Some(4));
        m.on_server(&json!({"k": "read-sync", "peer": "carol", "readTs": 1}));
        assert_eq!(m.contact("carol").map(|c| c.pending), Some(0));
        // This account's own message from another device is shown, owes nothing.
        let mine = json!({"k": "frame", "from": "bob", "self": true, "d": {"t": "msg", "id": "p1", "text": "from phone", "ts": 5}});
        assert!(m.on_server(&mine).is_empty());
        let last = conv(&m, "bob").msgs.last().expect("message");
        assert!(last.mine && last.text == "from phone");
        assert_eq!(m.take_read(), None);
    }

    #[test]
    fn waiting_messages_are_reported_read_only_once_they_are_on_screen() {
        let mut m = model(Some("bob"));
        ready(&mut m); // bob has 2 waiting
        assert_eq!(m.take_read(), None, "nothing is on screen yet");
        m.on_history("bob", Ok(json!({"messages": [
            {"id": "w1", "from": "bob", "text": "one", "ts": 1},
            {"id": "w2", "from": "bob", "text": "two", "ts": 2},
        ]})));
        assert_eq!(m.take_read(), Some(json!({"k": "mark-read", "peer": "bob"})));
        // A failed page load must not claim they were read.
        let mut m = model(Some("bob"));
        ready(&mut m);
        m.on_history("bob", Err("HTTP 500".to_owned()));
        assert_eq!(m.take_read(), None);
    }

    fn picture(w: u32, h: u32) -> Media {
        Media::from_bytes(crate::media::test_png(w, h)).expect("png")
    }

    #[test]
    fn a_history_picture_becomes_media_and_an_empty_one_a_tag() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        let with = picture(30, 20).to_value();
        m.on_history("bob", Ok(json!({"messages": [
            {"id": "i1", "from": "bob", "text": "look", "ts": 1, "image": with},
            {"id": "i2", "from": "bob", "text": "", "ts": 2, "image": {"width": 9, "height": 9}},
            {"id": "i3", "from": "bob", "text": "", "ts": 3, "image": {"dataUrl": "data:image/png;base64,AAAA"}},
        ]})));
        let msgs = &conv(&m, "bob").msgs;
        let first = msgs[0].image.as_ref().expect("readable");
        assert_eq!((first.width, first.height), (30, 20));
        assert!(msgs[0].tags.is_empty());
        assert!(msgs[1].image.is_none() && msgs[1].tags == ["[image]"], "the server dropped the data");
        assert!(msgs[2].image.is_none() && msgs[2].tags == ["[image]"], "damaged data is not a picture");
    }

    #[test]
    fn an_incoming_live_picture_is_shown_not_just_tagged() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        let frame = json!({"k": "frame", "from": "bob", "d": {"t": "msg", "id": "p1", "text": "", "image": picture(8, 8).to_value()}});
        m.on_server(&frame);
        assert!(conv(&m, "bob").msgs[0].image.is_some());
    }

    #[test]
    fn open_picks_the_nth_latest_picture() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        assert!(m.submit("/open").is_empty(), "nothing to open yet");
        assert!(m.status.as_ref().is_some_and(|(s, _)| s.contains("no picture")));
        for (id, w) in [("p1", 10), ("p2", 20)] {
            let frame = json!({"k": "frame", "from": "bob", "d": {"t": "msg", "id": id, "image": picture(w, 5).to_value()}});
            m.on_server(&frame);
        }
        let width_of = |effects: &[Effect]| match effects {
            [Effect::Open(media)] => media.width,
            other => panic!("{other:?}"),
        };
        assert_eq!(width_of(&m.submit("/open")), 20);
        assert_eq!(width_of(&m.submit("/open 2")), 10);
        assert!(m.submit("/open 3").is_empty());
        assert!(m.submit("/open zero").is_empty());
        assert!(m.status.as_ref().is_some_and(|(s, _)| s.contains("usage")));
    }

    #[test]
    fn the_img_command_splits_the_file_from_the_caption() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        let sent = |m: &mut Model, line: &str| match m.submit(line).as_slice() {
            [Effect::LoadImage { peer, path, caption }] => (peer.clone(), path.clone(), caption.clone()),
            other => panic!("{line}: {other:?}"),
        };
        let want = |p: &str, c: &str| ("bob".to_owned(), p.to_owned(), c.to_owned());
        assert_eq!(sent(&mut m, "/img /tmp/a.png"), want("/tmp/a.png", ""));
        assert_eq!(sent(&mut m, "/img /tmp/a.png look at this"), want("/tmp/a.png", "look at this"));
        assert_eq!(sent(&mut m, "/img \"/tmp/my pic.png\" hi"), want("\"/tmp/my pic.png\"", "hi"));
        assert_eq!(sent(&mut m, "/img '/tmp/my pic.png'"), want("'/tmp/my pic.png'", ""));
        assert_eq!(sent(&mut m, "/img /tmp/my\\ pic.png caption"), want("/tmp/my\\ pic.png", "caption"));
        assert_eq!(sent(&mut m, "/img C:\\Users\\me\\a.png"), want("C:\\Users\\me\\a.png", ""));
        assert!(m.submit("/img").is_empty());
        assert!(m.status.as_ref().is_some_and(|(s, _)| s.contains("usage")));
    }

    #[test]
    fn a_sent_picture_carries_its_data_and_is_resent_with_it() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        let effects = m.send_image("bob", picture(12, 6), "caption");
        let frame = sent_frame(&effects).clone();
        assert_eq!(frame["to"], "bob");
        assert_eq!(frame["d"]["text"], "caption");
        assert_eq!(frame["d"]["image"]["width"], 12);
        let url = frame["d"]["image"]["dataUrl"].as_str().expect("data url");
        assert!(url.starts_with("data:image/png;base64,"));
        assert_eq!(conv(&m, "bob").msgs[0].rung, Rung::Queued);

        m.set_link(LinkState::Offline { retry_at: 1 });
        let again = ready(&mut m);
        let resent = again
            .iter()
            .find_map(|e| match e {
                Effect::Send(v) if v["k"] == "frame" => Some(v),
                _ => None,
            })
            .expect("the message again");
        assert_eq!(resent["d"]["image"]["dataUrl"], frame["d"]["image"]["dataUrl"]);
        assert_eq!(resent["d"]["id"], frame["d"]["id"]);
    }

    #[test]
    fn old_pictures_give_way_to_the_memory_budget_but_unsent_ones_never() {
        let mut m = model(Some("bob"));
        ready(&mut m);
        let big = |ts: i64, mine: bool| Msg {
            id: format!("big-{ts}"),
            mine,
            author: String::new(),
            text: String::new(),
            tags: Vec::new(),
            image: Some(Arc::new(Media {
                bytes: vec![0; 10 * 1024 * 1024],
                mime: "image/png",
                ext: "png",
                width: 1,
                height: 1,
            })),
            ts,
            rung: if mine { Rung::Queued } else { Rung::Read },
            failed: false,
            system: false,
            edited: false,
            reactions: Vec::new(),
        };
        let conv = m.convs.entry("bob".to_owned()).or_default();
        for (ts, mine) in [(1, true), (2, false), (3, false), (4, false)] {
            upsert(conv, big(ts, mine));
        }
        let held: Vec<bool> = conv.msgs.iter().map(|x| x.image.is_some()).collect();
        assert_eq!(held, [true, false, false, true], "the unsent one and the newest stay; budget is 24 MiB");
        assert_eq!(conv.msgs[1].tags, ["[image]"]);
    }
}
