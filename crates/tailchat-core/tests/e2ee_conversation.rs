//! Two cores through a model of the server (spec E2EE §8.3, sub-stage 6c):
//! device registration, `keys/query`/`claim`, the to-device inbox and the
//! message relay, all in memory. What is checked is what a person would see
//! and what the server holds, not ciphertext bytes (vodozemac's randomness is
//! its own, §6).

mod common;

#[cfg(test)]
mod cases {
    use std::collections::{BTreeMap, BTreeSet, VecDeque};

    use serde_json::{Map, Value, json};
    use tailchat_core::frames::inner::{Forwarded, Reply};
    use tailchat_core::{
        Action, ApiCall, ApiRequest, BackupPassphraseKey, Core, Event, Extra, FetchError, Image,
        Input, Login, MessageId, OutVoice, Output, Protection, Receipt, Seal, Secret, Storage,
        StoreOp, Token, Ts,
    };

    /// Every account's password in the model server.
    const PASSWORD: &str = "correct horse";

    use super::common::MemStore as Store;

    /// The server: devices, one-time keys, to-device inboxes, relayed frames.
    #[derive(Default, Clone)]
    struct BackupState {
        version: u64,
        cross_signing: Option<Value>,
        passphrase: Option<Value>,
        sessions: BTreeMap<String, Value>,
    }

    /// The server: devices, one-time keys, to-device inboxes, backups, relayed frames.
    #[derive(Default)]
    struct Server {
        devices: BTreeMap<String, BTreeMap<String, Value>>,
        cross_signing: BTreeMap<String, Value>,
        otks: BTreeMap<(String, String), VecDeque<Value>>,
        fallback: BTreeMap<(String, String), Value>,
        legacy: BTreeMap<String, u32>,
        /// `(login, device) → name`, as `keys/upload` gave it.
        names: BTreeMap<(String, String), String>,
        /// `(login, device) → caps`, as `keys/upload` gave them.
        caps: BTreeMap<(String, String), Value>,
        /// Devices that act like a core from before the blob: whatever they
        /// upload, the server lists no `caps` for them.
        old: BTreeSet<(String, String)>,
        /// Every `ack` a client wrote, with its author.
        acks: Vec<(String, Value)>,
        inbox: BTreeMap<(String, String), Vec<Value>>,
        backups: BTreeMap<String, BackupState>,
        /// `login → peer → statement`, as `POST /api/e2ee/trust` gave them.
        trust: BTreeMap<String, BTreeMap<String, Value>>,
        seq: i64,
        /// Every message frame the server stored, in order.
        stored: Vec<(String, Value)>,
    }

    struct Client {
        login: String,
        device: String,
        core: Core,
        store: Store,
        /// Frames for this client not handed in yet.
        incoming: VecDeque<String>,
        posts: VecDeque<ApiRequest>,
        /// Drop every `Send` (a crash after the Persist).
        deaf: bool,
        /// What the UI heard.
        events: Vec<Event>,
        /// The next post's answer never arrives: `Some(true)` — the server
        /// acted on it; `Some(false)` — it never reached the server.
        lose_next_answer: Option<bool>,
    }

    fn login(s: &str) -> Login {
        Login::parse(s).unwrap()
    }

    impl Client {
        fn new(name: &str, device: &str) -> Self {
            Self::restore(name, device, Store::default())
        }
        fn restore(name: &str, device: &str, store: Store) -> Self {
            let mut core = Core::new(
                login(name),
                Token::parse(&"a".repeat(64)).unwrap(),
                store.load().unwrap(),
            );
            core.set_e2ee(true);
            Self {
                login: name.into(),
                device: device.into(),
                core,
                store,
                incoming: VecDeque::new(),
                posts: VecDeque::new(),
                deaf: false,
                events: Vec::new(),
                lose_next_answer: None,
            }
        }
    }

    struct World {
        server: Server,
        clients: Vec<Client>,
        now: i64,
    }

    impl World {
        fn new(clients: Vec<Client>) -> Self {
            Self {
                server: Server::default(),
                clients,
                now: 1_700_000_000_000,
            }
        }

        fn index(&self, name: &str, device: &str) -> usize {
            self.clients
                .iter()
                .position(|c| c.login == name && c.device == device)
                .unwrap()
        }

        fn connect(&mut self, i: usize) {
            let ready = json!({
                "k": "ready",
                "users": [{"login": "alice"}, {"login": "bob"}, {"login": "carol"}],
                "caps": ["e2ee-v1"]
            });
            self.input(i, Input::Connected);
            self.input(i, Input::Frame(ready.to_string()));
        }

        fn input(&mut self, i: usize, input: Input) {
            let outputs = self.clients[i].core.handle(Ts(self.now), input).unwrap();
            for output in outputs {
                match output {
                    Output::Persist(ops) => self.clients[i].store.apply(&ops).unwrap(),
                    Output::Send(frame) => {
                        if !self.clients[i].deaf {
                            self.on_frame(i, &frame);
                        }
                    }
                    Output::Post(request) => self.clients[i].posts.push_back(request),
                    Output::Event(event) => self.clients[i].events.push(event),
                    Output::Fetch(_) => {}
                }
            }
        }

        /// Runs until nobody has anything left to say.
        fn settle(&mut self) {
            for _ in 0..500 {
                let mut busy = false;
                for i in 0..self.clients.len() {
                    if let Some(request) = self.clients[i].posts.pop_front() {
                        busy = true;
                        let lost = self.clients[i].lose_next_answer.take();
                        let answered = match lost {
                            Some(false) => Err(FetchError::Network),
                            Some(true) => self.answer(i, &request).and(Err(FetchError::Network)),
                            None => self.answer(i, &request),
                        };
                        match answered {
                            Ok(body) => self.input(i, Input::Posted { request, body }),
                            Err(error) => self.input(i, Input::PostFailed { request, error }),
                        }
                    }
                    if let Some(frame) = self.clients[i].incoming.pop_front() {
                        busy = true;
                        self.input(i, Input::Frame(frame));
                    }
                    if self.clients[i]
                        .core
                        .next_wakeup()
                        .is_some_and(|at| at.0 <= self.now)
                    {
                        busy = true;
                        self.input(i, Input::Tick);
                    }
                }
                if !busy {
                    self.now += 50;
                    if self.clients.iter().all(|c| {
                        c.posts.is_empty()
                            && c.incoming.is_empty()
                            && c.core
                                .next_wakeup()
                                .is_none_or(|at| at.0 > self.now + 10_000)
                    }) {
                        return;
                    }
                }
            }
            panic!("the world never settled");
        }

        fn answer(&mut self, i: usize, request: &ApiRequest) -> Result<String, FetchError> {
            let (me, device) = (
                self.clients[i].login.clone(),
                self.clients[i].device.clone(),
            );
            let body: Value = serde_json::from_str(&request.body).unwrap();
            let server = &mut self.server;
            Ok(match request.call {
                ApiCall::KeysUpload => {
                    // Like `accounts.js`: replacing published keys takes the
                    // password, and refuses before touching anything.
                    let replacing = body.get("replaceCrossSigning") == Some(&Value::Bool(true))
                        && server.cross_signing.contains_key(&me);
                    if replacing && body.get("password").and_then(Value::as_str) != Some(PASSWORD) {
                        return Err(FetchError::Status(403, None));
                    }
                    let mut changed = false;
                    if let Some(keys) = body.get("deviceKeys") {
                        let entry = server.devices.entry(me.clone()).or_default();
                        if entry.get(&device) != Some(keys) {
                            changed = true;
                        }
                        entry.insert(device.clone(), keys.clone());
                    }
                    if let Some(cross) = body.get("crossSigning")
                        && (!server.cross_signing.contains_key(&me)
                            || body.get("replaceCrossSigning") == Some(&Value::Bool(true)))
                    {
                        server.cross_signing.insert(me.clone(), cross.clone());
                        changed = true;
                    }
                    let slot = (me.clone(), device.clone());
                    if let Some(name) = body.get("name").and_then(Value::as_str) {
                        server.names.insert(slot.clone(), name.to_owned());
                    }
                    let caps = body
                        .get("caps")
                        .filter(|_| !server.old.contains(&slot))
                        .cloned()
                        .unwrap_or_else(|| json!([]));
                    if server
                        .caps
                        .insert(slot.clone(), caps.clone())
                        .unwrap_or_else(|| json!([]))
                        != caps
                    {
                        changed = true;
                    }
                    if let Some(otks) = body.get("oneTimeKeys").and_then(Value::as_object) {
                        server
                            .otks
                            .entry(slot.clone())
                            .or_default()
                            .extend(otks.values().cloned());
                    }
                    if let Some(fallback) = body.get("fallbackKey").and_then(Value::as_object) {
                        server
                            .fallback
                            .insert(slot.clone(), fallback.values().next().unwrap().clone());
                    }
                    let registered = server
                        .devices
                        .get(&me)
                        .is_some_and(|d| d.contains_key(&device));
                    let out = json!({
                        "deviceId": device,
                        "registered": registered,
                        "oneTimeKeyCount": server.otks.get(&slot).map_or(0, VecDeque::len),
                        "fallbackKey": server.fallback.contains_key(&slot),
                    })
                    .to_string();
                    if changed {
                        let notice = json!({"k": "device-list-changed", "login": me}).to_string();
                        for c in &mut self.clients {
                            c.incoming.push_back(notice.clone());
                        }
                    }
                    out
                }
                ApiCall::KeysQuery => {
                    let mut users = Map::new();
                    for who in body["logins"].as_array().unwrap() {
                        let who = who.as_str().unwrap();
                        let devices: Map<String, Value> = server
                            .devices
                            .get(who)
                            .map(|d| {
                                d.iter()
                                    .map(|(id, keys)| {
                                        let name = server
                                            .names
                                            .get(&(who.to_owned(), id.clone()))
                                            .cloned()
                                            .unwrap_or_default();
                                        let caps = server
                                            .caps
                                            .get(&(who.to_owned(), id.clone()))
                                            .cloned()
                                            .unwrap_or_else(|| json!([]));
                                        (
                                            id.clone(),
                                            json!({"deviceKeys": keys, "name": name, "caps": caps}),
                                        )
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let cross = server
                            .cross_signing
                            .get(who)
                            .cloned()
                            .unwrap_or_else(|| json!({}));
                        let mut user = json!({
                            "crossSigning": cross,
                            "devices": devices,
                            "legacySessions": server.legacy.get(who).copied().unwrap_or(0)
                        });
                        // Like `accounts.js`: only the account itself reads it.
                        if who == me {
                            user["peerTrust"] =
                                json!(server.trust.get(who).cloned().unwrap_or_default());
                        }
                        users.insert(who.into(), user);
                    }
                    json!({ "users": users }).to_string()
                }
                ApiCall::KeysClaim => {
                    let mut keys = Map::new();
                    for (who, ids) in body["claims"].as_object().unwrap() {
                        let mut found = Map::new();
                        for id in ids.as_array().unwrap() {
                            let slot = (who.clone(), id.as_str().unwrap().to_owned());
                            let key = server
                                .otks
                                .get_mut(&slot)
                                .and_then(VecDeque::pop_front)
                                .or_else(|| server.fallback.get(&slot).cloned());
                            if let Some(key) = key {
                                found.insert(slot.1, json!({"keyId": "k", "key": key}));
                            }
                        }
                        keys.insert(who.clone(), Value::Object(found));
                    }
                    json!({ "keys": keys, "rateLimited": false }).to_string()
                }
                ApiCall::Trust => {
                    let entry = server.trust.entry(me.clone()).or_default();
                    let mut changed = false;
                    for (peer, statement) in body["peerTrust"].as_object().unwrap() {
                        if entry.get(peer) != Some(statement) {
                            entry.insert(peer.clone(), statement.clone());
                            changed = true;
                        }
                    }
                    if changed {
                        // Like `hub.trustChanged`: the account's own sessions.
                        let notice = json!({"k": "device-list-changed", "login": me}).to_string();
                        for c in &mut self.clients {
                            if c.login == me {
                                c.incoming.push_back(notice.clone());
                            }
                        }
                    }
                    json!({ "ok": true }).to_string()
                }
                ApiCall::Backup => {
                    let entry = server.backups.entry(me).or_default();
                    if let Some(version) = body.get("version").and_then(Value::as_u64) {
                        let replace =
                            body.get("replace") == Some(&Value::Bool(true)) || entry.version == 0;
                        if replace {
                            entry.version = version;
                            entry.cross_signing = body.get("crossSigning").cloned();
                            entry.passphrase = body.get("passphrase").cloned();
                            entry.sessions.clear();
                        }
                        if let Some(sessions) = body.get("sessions").and_then(Value::as_object) {
                            for (sid, item) in sessions {
                                let new_idx = item
                                    .get("firstKnownIndex")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(u64::MAX);
                                let keep = entry.sessions.get(sid).is_none_or(|cur| {
                                    new_idx
                                        < cur
                                            .get("firstKnownIndex")
                                            .and_then(Value::as_u64)
                                            .unwrap_or(u64::MAX)
                                });
                                if keep {
                                    entry.sessions.insert(sid.clone(), item.clone());
                                }
                            }
                        }
                    }
                    let include = body.get("includeSessions") == Some(&Value::Bool(true));
                    let sessions: Map<String, Value> = if include {
                        entry
                            .sessions
                            .iter()
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect()
                    } else {
                        Map::new()
                    };
                    json!({
                        "version": entry.version,
                        "crossSigning": entry.cross_signing,
                        "passphrase": entry.passphrase,
                        "sessionCount": entry.sessions.len(),
                        "sessions": sessions,
                    })
                    .to_string()
                }
            })
        }

        fn on_frame(&mut self, i: usize, raw: &str) {
            let frame: Value = serde_json::from_str(raw).unwrap();
            let me = self.clients[i].login.clone();
            let device = self.clients[i].device.clone();
            match frame["k"].as_str().unwrap() {
                "to-device" => {
                    self.server.seq += 1;
                    let target = (
                        frame["to"].as_str().unwrap().to_owned(),
                        frame["device"].as_str().unwrap().to_owned(),
                    );
                    let item = json!({"k":"to-device","seq":self.server.seq,"from":me,"fromDevice":device,"body":frame["body"]});
                    self.server
                        .inbox
                        .entry(target.clone())
                        .or_default()
                        .push(item.clone());
                    for c in &mut self.clients {
                        if (c.login.clone(), c.device.clone()) == target {
                            c.incoming.push_back(item.to_string());
                        }
                    }
                    let accepted =
                        json!({"k":"to-device-accepted","id":frame["id"],"seq":self.server.seq});
                    self.clients[i].incoming.push_back(accepted.to_string());
                }
                "frame" if frame["d"]["t"] == "ack" => {
                    self.server.acks.push((me.clone(), frame["d"].clone()));
                }
                "frame" if frame["d"]["t"] == "msg" => {
                    let to = frame["to"].as_str().unwrap().to_owned();
                    let d = frame["d"].clone();
                    self.server.stored.push((me.clone(), d.clone()));
                    let accepted =
                        json!({"k":"message-accepted","peer":to,"id":d["id"],"ts":self.now});
                    self.clients[i].incoming.push_back(accepted.to_string());
                    for (j, c) in self.clients.iter_mut().enumerate() {
                        if j == i {
                            continue;
                        }
                        let relayed = if c.login == to {
                            json!({"k":"frame","from":me,"d":d})
                        } else if c.login == me {
                            json!({"k":"frame","from":to,"self":true,"d":d})
                        } else {
                            continue;
                        };
                        c.incoming.push_back(relayed.to_string());
                    }
                }
                _ => {}
            }
        }

        fn send(&mut self, i: usize, to: &str, id: &str, text: &str) {
            self.input(
                i,
                Input::Action(Action::SendText {
                    id: MessageId::parse(id).unwrap(),
                    peer: login(to),
                    text: text.into(),
                }),
            );
        }

        fn send_image(
            &mut self,
            i: usize,
            to: &str,
            id: &str,
            text: &str,
            data_url: &str,
            size: (Option<i64>, Option<i64>),
        ) {
            self.input(
                i,
                Input::Action(Action::SendImage {
                    id: MessageId::parse(id).unwrap(),
                    peer: login(to),
                    text: text.into(),
                    image: Image {
                        data_url: data_url.into(),
                        width: size.0,
                        height: size.1,
                    },
                }),
            );
        }
    }

    fn row<'a>(c: &'a Client, peer: &str, id: &str) -> &'a tailchat_core::Message {
        c.store
            .message(peer, id)
            .unwrap_or_else(|| panic!("{} holds {peer}/{id}", c.login))
    }

    fn verify_via_sas(world: &mut World, initiator: usize, responder: usize) {
        let target_login = world.clients[responder].login.clone();
        let target_device = world.clients[responder].device.clone();
        world.input(
            initiator,
            Input::Action(Action::StartSas {
                peer: login(&target_login),
                device: target_device,
            }),
        );
        world.settle();
        let code_of = |c: &Client| {
            c.events
                .iter()
                .rev()
                .find_map(|e| match e {
                    Event::SasCodeReady {
                        transaction_id,
                        emoji_indices,
                        decimals,
                        ..
                    } => Some((transaction_id.clone(), *emoji_indices, *decimals)),
                    _ => None,
                })
                .expect("SasCodeReady")
        };
        let (tx_a, emojis_a, dec_a) = code_of(&world.clients[initiator]);
        let (tx_b, emojis_b, dec_b) = code_of(&world.clients[responder]);
        assert_eq!(tx_a, tx_b);
        assert_eq!(emojis_a, emojis_b, "both sides see the same 7 emojis");
        assert_eq!(dec_a, dec_b, "both sides see the same 3 decimals");
        world.input(
            initiator,
            Input::Action(Action::ConfirmSas {
                transaction_id: tx_a,
            }),
        );
        world.input(
            responder,
            Input::Action(Action::ConfirmSas {
                transaction_id: tx_b,
            }),
        );
        world.settle();
    }

    /// Runs a SAS from `initiator` to `responder` until both see the code.
    fn sas_until_code(world: &mut World, initiator: usize, responder: usize) -> String {
        let target_login = world.clients[responder].login.clone();
        let target_device = world.clients[responder].device.clone();
        world.input(
            initiator,
            Input::Action(Action::StartSas {
                peer: login(&target_login),
                device: target_device,
            }),
        );
        world.settle();
        let tx_of = |c: &Client| {
            c.events.iter().rev().find_map(|e| match e {
                Event::SasCodeReady { transaction_id, .. } => Some(transaction_id.clone()),
                _ => None,
            })
        };
        let tx = tx_of(&world.clients[initiator]).expect("initiator sees the code");
        assert_eq!(
            tx_of(&world.clients[responder]).as_deref(),
            Some(tx.as_str())
        );
        tx
    }

    fn cancels(c: &Client, from: usize) -> Vec<(String, String, String, String)> {
        c.events[from..]
            .iter()
            .filter_map(|e| match e {
                Event::SasCancelled {
                    transaction_id,
                    peer,
                    device,
                    reason,
                    ..
                } => Some((
                    transaction_id.clone(),
                    peer.as_str().to_owned(),
                    device.clone(),
                    reason.clone(),
                )),
                _ => None,
            })
            .collect()
    }

    fn verified_since(c: &Client, from: usize) -> bool {
        c.events[from..]
            .iter()
            .any(|e| matches!(e, Event::DeviceVerified { .. }))
    }

    fn registered(names: &[(&str, &str)]) -> World {
        let mut world = World::new(names.iter().map(|(n, d)| Client::new(n, d)).collect());
        for i in 0..names.len() {
            world.connect(i);
        }
        world.settle();
        for i in 0..names.len() {
            let first = names.iter().position(|(n, _)| *n == names[i].0).unwrap();
            if first < i {
                verify_via_sas(&mut world, first, i);
            }
        }
        world
    }

    #[test]
    fn the_other_side_saying_no_ends_the_handshake_here_too() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let (alice, bob) = (0, 1);
        let tx = sas_until_code(&mut world, alice, bob);
        let (from_a, from_b) = (
            world.clients[alice].events.len(),
            world.clients[bob].events.len(),
        );

        // bob answers "no": alice, still waiting for an answer, is told.
        world.input(
            bob,
            Input::Action(Action::CancelSas {
                transaction_id: tx.clone(),
            }),
        );
        world.settle();
        assert_eq!(
            cancels(&world.clients[alice], from_a),
            vec![(
                tx.clone(),
                "bob".into(),
                "BBBBBBBBBBBBBBBB".into(),
                "user_cancelled".into()
            )],
        );
        assert!(
            cancels(&world.clients[bob], from_b).is_empty(),
            "a cancel this device asked for is not reported back to it"
        );

        // alice's late "yes" finds nothing to confirm: nobody is verified.
        world.input(
            alice,
            Input::Action(Action::ConfirmSas { transaction_id: tx }),
        );
        world.settle();
        assert!(!verified_since(&world.clients[alice], from_a));
        assert!(!verified_since(&world.clients[bob], from_b));
    }

    #[test]
    fn a_side_that_already_said_yes_hears_when_the_other_says_no() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let (alice, bob) = (0, 1);
        let tx = sas_until_code(&mut world, alice, bob);
        let (from_a, from_b) = (
            world.clients[alice].events.len(),
            world.clients[bob].events.len(),
        );

        // bob confirms first and now waits for alice; alice says no.
        world.input(
            bob,
            Input::Action(Action::ConfirmSas {
                transaction_id: tx.clone(),
            }),
        );
        world.settle();
        world.input(
            alice,
            Input::Action(Action::CancelSas {
                transaction_id: tx.clone(),
            }),
        );
        world.settle();
        assert_eq!(
            cancels(&world.clients[bob], from_b),
            vec![(
                tx,
                "alice".into(),
                "AAAAAAAAAAAAAAAA".into(),
                "user_cancelled".into()
            )],
        );
        assert!(!verified_since(&world.clients[alice], from_a));
        assert!(!verified_since(&world.clients[bob], from_b));
    }

    #[test]
    fn a_message_goes_encrypted_and_both_devices_of_the_reader_read_it() {
        let mut world = registered(&[
            ("alice", "AAAAAAAAAAAAAAAA"),
            ("bob", "BBBBBBBBBBBBBBBB"),
            ("bob", "CCCCCCCCCCCCCCCC"),
        ]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        world.send(alice, "bob", "m-1", "секрет");
        world.settle();

        // The server stored an envelope and no text.
        let (_, stored) = &world.server.stored[0];
        assert!(stored.get("text").is_none(), "{stored}");
        assert_eq!(stored["e2ee"]["v"], 1);

        for device in ["BBBBBBBBBBBBBBBB", "CCCCCCCCCCCCCCCC"] {
            let bob = &world.clients[world.index("bob", device)];
            let message = row(bob, "alice", "m-1");
            assert_eq!(message.text, "секрет");
            assert_eq!(message.protection, Protection::Encrypted);
        }
        let mine = &world.clients[alice].store.snapshot.sent;
        assert!(
            mine.iter()
                .any(|m| m.id.as_str() == "m-1" && m.receipt != Receipt::Queued)
        );
        assert!(
            world.clients[alice].store.snapshot.to_device.is_empty(),
            "keys accepted"
        );
    }

    #[test]
    fn a_crash_after_sealing_resends_the_same_envelope_and_never_reuses_an_index() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        // A session in use: its ratchet is on disk past index 0.
        world.send(alice, "bob", "m-0", "zero");
        world.settle();
        let stored_before = world.server.stored.len();
        // Alice seals and persists, but nothing reaches the server.
        world.clients[alice].deaf = true;
        world.send(alice, "bob", "m-1", "first");
        world.settle();
        let sealed = world.clients[alice]
            .store
            .snapshot
            .pending
            .iter()
            .find(|r| r.message.id.as_str() == "m-1")
            .map(|r| r.seal.clone())
            .unwrap();
        let Seal::Encrypted(envelope) = sealed else {
            panic!("sealed before the wire: {sealed:?}");
        };
        assert_eq!(world.server.stored.len(), stored_before);

        // Restart from the disk.
        let store = world.clients[alice].store.clone();
        world.clients[alice] = Client::restore("alice", "AAAAAAAAAAAAAAAA", store);
        world.connect(alice);
        world.settle();
        world.send(alice, "bob", "m-2", "second");
        world.settle();

        let sent: Vec<&Value> = world.server.stored.iter().map(|(_, d)| d).collect();
        let first = sent.iter().find(|d| d["id"] == "m-1").unwrap();
        assert_eq!(
            first["e2ee"]["ct"], envelope.ct,
            "the same bytes after the crash"
        );
        let second = sent.iter().find(|d| d["id"] == "m-2").unwrap();
        assert_ne!(second["e2ee"]["ct"], first["e2ee"]["ct"]);
        let bob = &world.clients[world.index("bob", "BBBBBBBBBBBBBBBB")];
        assert_eq!(row(bob, "alice", "m-1").text, "first");
        // Under a reused index the reader refuses the second as a replay.
        assert_eq!(row(bob, "alice", "m-2").text, "second");
        assert_eq!(row(bob, "alice", "m-2").protection, Protection::Encrypted);
    }

    #[test]
    fn a_message_before_its_key_waits_sealed_and_opens_when_the_key_comes() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        let bob = world.index("bob", "BBBBBBBBBBBBBBBB");
        world.send(alice, "bob", "m-1", "late key");
        // Deliver alice's frames, then hand bob the message before the key.
        for _ in 0..50 {
            if let Some(request) = world.clients[alice].posts.pop_front() {
                let body = world.answer(alice, &request).unwrap();
                world.input(alice, Input::Posted { request, body });
            }
            if let Some(frame) = world.clients[alice].incoming.pop_front() {
                world.input(alice, Input::Frame(frame));
            }
            world.now += 50;
            world.input(alice, Input::Tick);
        }
        let incoming: Vec<String> = world.clients[bob].incoming.drain(..).collect();
        let (keys, messages): (Vec<String>, Vec<String>) = incoming
            .into_iter()
            .partition(|f| f.contains("\"to-device\""));
        for frame in messages {
            world.input(bob, Input::Frame(frame));
        }
        let waiting = row(&world.clients[bob], "alice", "m-1");
        assert!(
            matches!(waiting.protection, Protection::Sealed { waiting: true, .. }),
            "{:?}",
            waiting.protection
        );
        assert!(waiting.text.is_empty(), "never shown as text");
        assert_eq!(world.clients[bob].store.load().unwrap().sealed.len(), 1);

        for frame in keys {
            world.input(bob, Input::Frame(frame));
        }
        world.settle();
        let opened = row(&world.clients[bob], "alice", "m-1");
        assert_eq!(opened.text, "late key");
        assert_eq!(opened.protection, Protection::Encrypted);
        assert!(world.clients[bob].store.load().unwrap().sealed.is_empty());
    }

    #[test]
    fn a_restarted_core_tells_its_encrypted_conversations_on_connect_once() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        world.send(alice, "bob", "m-1", "encrypted");
        world.settle();

        let store = std::mem::take(&mut world.clients[alice].store);
        world.clients[alice] = Client::restore("alice", "AAAAAAAAAAAAAAAA", store);
        world.connect(alice);
        let told = |events: &[Event]| {
            events
                .iter()
                .filter(|e| {
                    matches!(e, Event::EncryptionState { peer, encrypted: true }
                        if peer.as_str() == "bob")
                })
                .count()
        };
        assert_eq!(told(&world.clients[alice].events), 1, "before any send");
        assert!(
            !world.clients[alice].events.iter().any(|e| matches!(
                e,
                Event::EncryptionState { peer, .. } if peer.as_str() != "bob"
            )),
            "only conversations that were encrypted"
        );

        world.clients[alice].events.clear();
        world.connect(alice);
        assert_eq!(told(&world.clients[alice].events), 0, "said once per run");
    }

    #[test]
    fn the_receiver_hears_its_conversation_is_encrypted_without_sending_once() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        let bob = world.index("bob", "BBBBBBBBBBBBBBBB");
        let told = |events: &[Event]| {
            events
                .iter()
                .filter(|e| {
                    matches!(e, Event::EncryptionState { peer, encrypted: true }
                        if peer.as_str() == "alice")
                })
                .count()
        };
        world.clients[bob].events.clear();
        world.send(alice, "bob", "m-1", "first sealed");
        world.settle();
        // Bob has sent nothing: the lock comes from alice's room key and the
        // sealed row he opened with it.
        assert_eq!(told(&world.clients[bob].events), 1, "told on the first sealed row");

        world.clients[bob].events.clear();
        world.send(alice, "bob", "m-2", "second sealed");
        world.settle();
        world.connect(bob);
        world.settle();
        assert_eq!(told(&world.clients[bob].events), 0, "said once per run");
    }

    #[test]
    fn an_encrypted_conversation_never_falls_back_to_open_text_unasked() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        world.send(alice, "bob", "m-1", "encrypted");
        world.settle();
        assert!(world.clients[alice].events.iter().any(|e| matches!(
            e,
            Event::EncryptionState {
                encrypted: true,
                ..
            }
        )));
        // Bob signs in somewhere that cannot decrypt; alice hears of it.
        world.server.legacy.insert("bob".into(), 1);
        world.connect(alice);
        world.settle();
        world.clients[alice].events.clear();
        world.send(alice, "bob", "m-2", "would be open");
        world.settle();
        let stored = world.server.stored.len();
        assert!(
            world.server.stored.iter().all(|(_, d)| d["id"] != "m-2"),
            "held, not sent"
        );
        let events = &world.clients[alice].events;
        assert!(
            events
                .iter()
                .any(|e| matches!(e, Event::PlaintextHeld { id, .. } if id.as_str() == "m-2"))
        );
        assert!(events.iter().any(|e| matches!(
            e,
            Event::EncryptionState {
                encrypted: false,
                ..
            }
        )));
        // A held row sets no timer: the core is idle, not spinning.
        assert!(
            world.clients[alice]
                .core
                .next_wakeup()
                .is_none_or(|at| at.0 > world.now)
        );

        world.input(
            alice,
            Input::Action(Action::SendUnencrypted {
                peer: login("bob"),
                id: MessageId::parse("m-2").unwrap(),
            }),
        );
        world.settle();
        assert_eq!(world.server.stored.len(), stored + 1);
        let (_, sent) = world.server.stored.last().unwrap();
        assert_eq!(sent["text"], "would be open");
        let bob = &world.clients[world.index("bob", "BBBBBBBBBBBBBBBB")];
        assert_eq!(row(bob, "alice", "m-2").protection, Protection::Plain);
    }

    #[test]
    fn a_withdrawn_held_message_is_never_sent_open_or_encrypted() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        world.send(alice, "bob", "m-1", "encrypted");
        world.settle();
        world.server.legacy.insert("bob".into(), 1);
        world.connect(alice);
        world.settle();
        world.send(alice, "bob", "m-2", "changed my mind");
        world.settle();
        let held = |e: &Event| matches!(e, Event::PlaintextHeld { id, .. } if id.as_str() == "m-2");
        assert!(world.clients[alice].events.iter().any(held));
        world.clients[alice].events.clear();

        // A row that was never held cannot be withdrawn: it may be on the wire.
        let refused = world.clients[alice].core.handle(
            Ts(world.now),
            Input::Action(Action::CancelHeld {
                peer: login("bob"),
                id: MessageId::parse("m-1").unwrap(),
            }),
        );
        assert!(refused.is_err(), "m-1 was sent, not held");

        world.input(
            alice,
            Input::Action(Action::CancelHeld {
                peer: login("bob"),
                id: MessageId::parse("m-2").unwrap(),
            }),
        );
        let events = &world.clients[alice].events;
        assert!(events.iter().any(|e| matches!(
            e,
            Event::MessagesRemoved { ids, .. } if ids.iter().any(|id| id.as_str() == "m-2")
        )));
        let snap = &world.clients[alice].store.snapshot;
        assert!(snap.pending.iter().all(|r| r.message.id.as_str() != "m-2"));
        // Twice is refused, not repeated.
        let again = world.clients[alice].core.handle(
            Ts(world.now),
            Input::Action(Action::CancelHeld {
                peer: login("bob"),
                id: MessageId::parse("m-2").unwrap(),
            }),
        );
        assert!(again.is_err());

        // Bob's last device that could not decrypt goes away: the encrypted
        // path opens, and a held row would leave now. A withdrawn one does not.
        world.server.legacy.remove("bob");
        world.connect(alice);
        world.settle();
        world.now += 120_000;
        world.input(alice, Input::Tick);
        world.settle();
        assert!(
            world.server.stored.iter().all(|(_, d)| d["id"] != "m-2"),
            "withdrawn, never sent"
        );
        // Neither after a restart from the store.
        let store = world.clients[alice].store.clone();
        world.clients[alice] = Client::restore("alice", "AAAAAAAAAAAAAAAA", store);
        world.connect(alice);
        world.settle();
        assert!(world.server.stored.iter().all(|(_, d)| d["id"] != "m-2"));
        assert!(!world.clients[alice].events.iter().any(held));
    }

    #[test]
    fn a_reader_with_a_device_that_cannot_decrypt_gets_open_text() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        world.server.legacy.insert("bob".into(), 1);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        world.send(alice, "bob", "m-1", "open");
        world.settle();
        let (_, stored) = &world.server.stored[0];
        assert_eq!(stored["text"], "open");
        assert!(stored.get("e2ee").is_none());
        let bob = &world.clients[world.index("bob", "BBBBBBBBBBBBBBBB")];
        assert_eq!(row(bob, "alice", "m-1").protection, Protection::Plain);
        // Nothing was encrypted: the conversation is not marked.
        assert!(
            !world.clients[alice]
                .store
                .snapshot
                .encrypted
                .contains(&login("bob"))
        );
        let _ = StoreOp::DropAck(login("bob"));
    }

    #[test]
    fn forged_envelopes_spliced_history_and_open_edits_are_refused() {
        let mut world = registered(&[
            ("alice", "AAAAAAAAAAAAAAAA"),
            ("bob", "BBBBBBBBBBBBBBBB"),
            ("carol", "CCCCCCCCCCCCCCCC"),
        ]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        let bob = world.index("bob", "BBBBBBBBBBBBBBBB");
        let carol = world.index("carol", "CCCCCCCCCCCCCCCC");

        // 1. A garbage/forged e2ee field in a conversation that has never encrypted
        // must not mark the conversation as encrypted or hold back open text.
        world.server.legacy.insert("bob".into(), 1);
        world.input(
            alice,
            Input::Frame(
                json!({
                    "k": "frame",
                    "from": "bob",
                    "d": {"t": "msg", "id": "forged-1", "e2ee": {"v": 2}}
                })
                .to_string(),
            ),
        );
        assert!(
            !world.clients[alice]
                .store
                .snapshot
                .encrypted
                .contains(&login("bob")),
            "unauthenticated e2ee frame must not mark conversation encrypted"
        );
        world.send(alice, "bob", "plain-1", "still open");
        world.settle();
        assert_eq!(
            row(&world.clients[bob], "alice", "plain-1").text,
            "still open"
        );
        world.server.legacy.remove("bob");
        world.connect(alice);
        world.settle();

        // 2. Carol sends Alice an encrypted message; the server splices Carol's
        // record into Alice's history walk with Bob.
        world.send(carol, "alice", "c-1", "carol secret");
        world.settle();
        assert_eq!(
            row(&world.clients[alice], "carol", "c-1").text,
            "carol secret"
        );
        let carol_envelope = world
            .server
            .stored
            .iter()
            .find(|(_, d)| d["id"] == "c-1")
            .unwrap()
            .1["e2ee"]
            .clone();
        world.input(
            alice,
            Input::Frame(
                json!({
                    "k": "sync-page",
                    "events": [{"seq": 50, "kind": "message", "peer": "bob", "id": "spliced-1", "ts": 100, "from": "bob"}],
                    "cursor": 50,
                    "more": false,
                    "reset": false
                })
                .to_string(),
            ),
        );
        let req = tailchat_core::HistoryRequest {
            serial: 1,
            peer: login("bob"),
            below: None,
            limit: 200,
            sealed: true,
        };
        world.input(
            alice,
            Input::History {
                request: req,
                body: json!({
                    "messages": [{
                        "id": "spliced-1",
                        "from": "carol",
                        "ts": 100,
                        "text": "",
                        "e2ee": carol_envelope
                    }]
                })
                .to_string(),
            },
        );
        let spliced = row(&world.clients[alice], "bob", "spliced-1");
        assert_eq!(
            spliced.text, "",
            "spliced message from another conversation must not decrypt"
        );
        assert!(matches!(
            spliced.protection,
            Protection::Sealed { waiting: false, .. }
        ));

        // 3. Bob sends Alice a real encrypted message; an open-text edit from the
        // server must not overwrite its decrypted text.
        world.send(bob, "alice", "b-1", "authentic");
        world.settle();
        assert_eq!(row(&world.clients[alice], "bob", "b-1").text, "authentic");
        world.input(
            alice,
            Input::Frame(
                json!({
                    "k": "sync-page",
                    "events": [{"seq": 51, "kind": "edit", "peer": "bob", "id": "b-1", "text": "forged edit", "ts": 999_999_999}],
                    "cursor": 51,
                    "more": false,
                    "reset": false
                })
                .to_string(),
            ),
        );
        assert_eq!(
            row(&world.clients[alice], "bob", "b-1").text,
            "authentic",
            "open-text edit must not overwrite an encrypted message"
        );
    }

    /// Item 6 of the live test: the lines about a device named it by its
    /// random id. The name goes up with `keys/upload`, comes back from
    /// `keys/query`, and rides every event that names a device; a device
    /// that never said its name stays "" (the shell falls back to the id).
    #[test]
    fn device_names_travel_from_upload_to_the_verification_events() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let mut named = Client::new("bob", "CCCCCCCCCCCCCCCC");
        named.core.set_device_name("Chrome · macOS".to_owned());
        world.clients.push(named);
        let bob2 = world.index("bob", "CCCCCCCCCCCCCCCC");
        world.connect(bob2);
        world.settle();
        assert_eq!(
            world
                .server
                .names
                .get(&("bob".to_owned(), "CCCCCCCCCCCCCCCC".to_owned()))
                .map(String::as_str),
            Some("Chrome · macOS"),
            "keys/upload carries the name"
        );

        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        let bob1 = world.index("bob", "BBBBBBBBBBBBBBBB");
        world.send(alice, "bob", "m-1", "hello");
        world.settle();
        assert!(world.clients[alice].events.iter().any(|e| matches!(
            e,
            Event::UnverifiedDevice { device, name, .. }
            if device == "CCCCCCCCCCCCCCCC" && name == "Chrome · macOS"
        )));

        verify_via_sas(&mut world, bob1, bob2);
        assert!(world.clients[bob1].events.iter().any(|e| matches!(
            e,
            Event::DeviceVerified { device, name, .. }
            if device == "CCCCCCCCCCCCCCCC" && name == "Chrome · macOS"
        )));
        assert!(world.clients[bob2].events.iter().any(|e| matches!(
            e,
            Event::DeviceVerified { device, name, .. }
            if device == "BBBBBBBBBBBBBBBB" && name.is_empty()
        )));
    }

    #[test]
    fn an_unverified_device_receives_no_key_until_verified_by_sas_and_then_gets_forwarded_keys() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        // Bob signs in on a second device without verifying it yet.
        world.clients.push(Client::new("bob", "CCCCCCCCCCCCCCCC"));
        let bob2 = world.index("bob", "CCCCCCCCCCCCCCCC");
        world.connect(bob2);
        world.settle();

        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        let bob1 = world.index("bob", "BBBBBBBBBBBBBBBB");
        world.send(alice, "bob", "m-1", "before sas");
        world.settle();

        // Alice warns about Bob's unverified device, and only B1 gets the key.
        assert!(world.clients[alice].events.iter().any(|e| matches!(
            e,
            Event::UnverifiedDevice { peer, device, .. }
            if peer.as_str() == "bob" && device == "CCCCCCCCCCCCCCCC"
        )));
        assert_eq!(row(&world.clients[bob1], "alice", "m-1").text, "before sas");
        let held_at_bob2 = row(&world.clients[bob2], "alice", "m-1");
        assert_eq!(held_at_bob2.text, "");
        assert!(matches!(
            held_at_bob2.protection,
            Protection::Sealed { waiting: true, .. }
        ));
        let sid = match &held_at_bob2.protection {
            Protection::Sealed { envelope, .. } => envelope.sid.clone(),
            _ => unreachable!(),
        };

        // B1 and B2 complete SAS verification: B1 shares Bob's CrossSigning over Olm,
        // B2 uploads its cross-signed deviceKeys, requests the missing key from B1,
        // and opens m-1 (marked sender_verified = false until a direct RoomKey arrives).
        verify_via_sas(&mut world, bob1, bob2);
        assert!(world.clients[bob1].events.iter().any(|e| matches!(
            e,
            Event::DeviceVerified { peer, device, .. }
            if peer.as_str() == "bob" && device == "CCCCCCCCCCCCCCCC"
        )));
        assert_eq!(
            row(&world.clients[bob2], "alice", "m-1").text,
            "before sas",
            "forwarded key opens the waiting message"
        );
        assert_eq!(
            row(&world.clients[bob2], "alice", "m-1").protection,
            Protection::Encrypted
        );
        assert_eq!(
            world.clients[bob2]
                .core
                .is_session_verified(&login("alice"), "AAAAAAAAAAAAAAAA", &sid),
            Some(false),
            "forwarded session is marked unverified until direct SessionKey arrives"
        );

        // Alice sends m-2: now B2 is verified, so Alice shares the direct RoomKey
        // with B2 too, upgrading B2's session to sender_verified = true.
        world.send(alice, "bob", "m-2", "after sas");
        world.settle();
        assert_eq!(row(&world.clients[bob2], "alice", "m-2").text, "after sas");
        assert_eq!(
            world.clients[bob2]
                .core
                .is_session_verified(&login("alice"), "AAAAAAAAAAAAAAAA", &sid),
            Some(true),
            "direct SessionKey upgrades the session to verified"
        );
    }

    #[test]
    fn a_master_key_change_stops_sending_until_accepted_and_rotates_the_session() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        let bob = world.index("bob", "BBBBBBBBBBBBBBBB");
        world.send(alice, "bob", "m-1", "first");
        world.settle();
        let first_sid = world.server.stored.last().unwrap().1["e2ee"]["sid"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            world.clients[alice].store.snapshot.peer_identities.len(),
            1,
            "TOFU recorded Bob's master key"
        );

        // Bob resets his account's master key on the server.
        world.server.cross_signing.remove("bob");
        world.server.devices.remove("bob");
        world.server.otks.retain(|(u, _), _| u != "bob");
        world.server.fallback.retain(|(u, _), _| u != "bob");
        world.clients[bob] = Client::new("bob", "BBBBBBBBBBBBBBBB");
        world.connect(bob);
        world.settle();

        // Alice queues m-2: she sees Bob's new master key, emits KeyChanged, and
        // holds m-2 without sending it.
        let stored_before = world.server.stored.len();
        world.send(alice, "bob", "m-2", "held on key change");
        world.settle();
        assert_eq!(
            world.server.stored.len(),
            stored_before,
            "must not send after master key change"
        );
        assert!(world.clients[alice].events.iter().any(|e| matches!(
            e,
            Event::KeyChanged { peer } if peer.as_str() == "bob"
        )));
        assert!(
            world.clients[alice]
                .core
                .next_wakeup()
                .is_none_or(|at| at.0 > world.now),
            "held on key change sets no spinning timer"
        );

        // Alice accepts Bob's new master key (or verifies by QR): the outbound
        // session rotates and m-2 goes out encrypted to Bob's new identity.
        let bob_qr = world.clients[bob].core.qr_verification().unwrap();
        world.input(alice, Input::Action(Action::VerifyWithQr { qr: bob_qr }));
        world.settle();
        assert_eq!(world.server.stored.len(), stored_before + 1);
        let second_sid = world.server.stored.last().unwrap().1["e2ee"]["sid"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(
            first_sid, second_sid,
            "outbound session rotated on trust change"
        );
        assert_eq!(
            row(&world.clients[bob], "alice", "m-2").text,
            "held on key change"
        );
        assert!(
            world.clients[alice].store.snapshot.peer_identities[0].verified,
            "QR verification marks the peer identity as verified"
        );
    }

    #[test]
    fn a_new_device_reads_old_encrypted_history_from_backup_by_recovery_key_or_passphrase() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice1 = world.index("alice", "AAAAAAAAAAAAAAAA");
        let bob1 = world.index("bob", "BBBBBBBBBBBBBBBB");

        // Alice and Bob exchange encrypted messages before any backup or second device exists.
        world.send(alice1, "bob", "m-a1", "from alice before backup");
        world.send(bob1, "alice", "m-b1", "from bob before backup");
        world.settle();
        assert_eq!(
            row(&world.clients[alice1], "bob", "m-b1").text,
            "from bob before backup"
        );

        // Alice creates an encrypted key backup with an optional passphrase.
        let pw_key = BackupPassphraseKey::derive_new("correct horse battery staple").unwrap();
        world.input(
            alice1,
            Input::Action(Action::CreateBackup {
                passphrase_key: Some(pw_key),
            }),
        );
        world.settle();

        let recovery_key = world.clients[alice1]
            .events
            .iter()
            .find_map(|e| match e {
                Event::BackupCreated {
                    version: 1,
                    recovery_key,
                } => Some(recovery_key.clone()),
                _ => None,
            })
            .expect("BackupCreated emitted with recovery key");
        assert_eq!(
            format!("{recovery_key:?}"),
            "[redacted]",
            "recovery key Debug must never print secret material"
        );
        assert!(
            world.clients[alice1].store.snapshot.backup_key.is_some(),
            "backup key persisted in SQLCipher store"
        );

        // Bob rotates his session and sends m-b2; Alice's device automatically uploads
        // the new inbound session to the backup.
        world.input(
            bob1,
            Input::Action(Action::AcceptPeerKey {
                peer: login("alice"),
            }),
        );
        world.send(bob1, "alice", "m-b2", "from bob on second session");
        world.settle();
        assert_eq!(
            world.server.backups["alice"].sessions.len(),
            3,
            "Alice's own outbound half + Bob's two sessions backed up on server"
        );

        // Alice's first device goes deaf (offline/lost), and Alice signs in on a brand-new
        // device A2 that receives the historical encrypted envelopes while A1 cannot forward.
        world.clients[alice1].deaf = true;
        world.clients.push(Client::new("alice", "CCCCCCCCCCCCCCCC"));
        let alice2 = world.index("alice", "CCCCCCCCCCCCCCCC");
        world.connect(alice2);
        world.settle();

        for (from, d) in world.server.stored.clone() {
            let delivered = if from == "alice" {
                json!({ "k": "frame", "from": "bob", "self": true, "d": d })
            } else {
                json!({ "k": "frame", "from": "bob", "d": d })
            };
            world.clients[alice2]
                .incoming
                .push_back(delivered.to_string());
        }
        world.settle();

        // Before restoring the backup, A2 holds the rows sealed (waiting for keys).
        assert!(matches!(
            row(&world.clients[alice2], "bob", "m-b1").protection,
            Protection::Sealed { waiting: true, .. }
        ));
        assert!(matches!(
            row(&world.clients[alice2], "bob", "m-b2").protection,
            Protection::Sealed { waiting: true, .. }
        ));

        // A2 unlocks the backup using the recovery key (no KDF): it signs its own device
        // keys with the recovered self-signing secret and unseals all historical messages.
        world.input(
            alice2,
            Input::Action(Action::RestoreBackupWithRecoveryKey { recovery_key }),
        );
        world.settle();

        assert!(world.clients[alice2].events.iter().any(|e| matches!(
            e,
            Event::BackupRestored {
                version: 1,
                sessions: 3,
            }
        )));
        assert_eq!(
            row(&world.clients[alice2], "bob", "m-a1").text,
            "from alice before backup"
        );
        assert_eq!(
            row(&world.clients[alice2], "bob", "m-b1").text,
            "from bob before backup"
        );
        assert_eq!(
            row(&world.clients[alice2], "bob", "m-b2").text,
            "from bob on second session"
        );
        assert_eq!(
            row(&world.clients[alice2], "bob", "m-b2").protection,
            Protection::Encrypted
        );

        // Because A2 signed its own deviceKeys with the recovered self-signing key,
        // Bob trusts A2 automatically and sends m-b3 to A2 without any UnverifiedDevice warning.
        world.send(bob1, "alice", "m-b3", "to cross-signed A2");
        world.settle();
        assert_eq!(
            row(&world.clients[alice2], "bob", "m-b3").text,
            "to cross-signed A2"
        );

        // A third new device A3 restores the same backup using the passphrase + server salt.
        world.clients[alice2].deaf = true;
        world.clients.push(Client::new("alice", "DDDDDDDDDDDDDDDD"));
        let alice3 = world.index("alice", "DDDDDDDDDDDDDDDD");
        world.connect(alice3);
        world.settle();

        world.input(alice3, Input::Action(Action::FetchBackup));
        world.settle();
        let salt = world.clients[alice3]
            .core
            .backup_passphrase_salt()
            .expect("passphrase salt fetched from server")
            .to_owned();
        let derived =
            BackupPassphraseKey::derive_with_salt("correct horse battery staple", &salt).unwrap();
        world.input(
            alice3,
            Input::Action(Action::RestoreBackupWithPassphrase {
                passphrase_key: derived,
            }),
        );
        world.settle();
        assert!(
            world.clients[alice3]
                .events
                .iter()
                .any(|e| matches!(e, Event::BackupRestored { version: 1, .. }))
        );
    }

    /// The master key this client's account holds, from its QR code (the
    /// only public view of the account's cross-signing keys the core gives).
    fn local_master(c: &Client) -> String {
        let qr = c.core.qr_verification().unwrap();
        qr.rsplit(':').next().unwrap().to_owned()
    }

    fn published_master(world: &World, who: &str) -> String {
        world.server.cross_signing[who]["master"]["key"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn reset(world: &mut World, i: usize, password: &str) {
        world.input(
            i,
            Input::Action(Action::ResetCrossSigning {
                password: Secret::from_string(password.into()),
            }),
        );
    }

    fn reset_failures(c: &Client) -> Vec<String> {
        c.events
            .iter()
            .filter_map(|e| match e {
                Event::CrossSigningResetFailed { reason } => Some(reason.clone()),
                _ => None,
            })
            .collect()
    }

    /// Bob loses his only device and has no backup. His new device is signed
    /// by a key nobody knows, so Alice gives it nothing — until he resets the
    /// account's keys with his password and Alice accepts the change.
    #[test]
    fn a_lost_device_without_backup_resets_the_account_keys_with_the_password() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        let bob = world.index("bob", "BBBBBBBBBBBBBBBB");
        world.send(alice, "bob", "m-1", "before the loss");
        world.settle();
        let old_master = published_master(&world, "bob");

        // Alice restarts: what she knows of Bob's devices is gone from memory,
        // only his pinned master key comes back from the store.
        let store = world.clients[alice].store.clone();
        world.clients[alice] = Client::restore("alice", "AAAAAAAAAAAAAAAA", store);
        world.connect(alice);
        world.settle();

        // The phone is gone; a new sign-in is a new device with a fresh store.
        world
            .server
            .devices
            .get_mut("bob")
            .unwrap()
            .remove("BBBBBBBBBBBBBBBB");
        world.clients[bob] = Client::new("bob", "CCCCCCCCCCCCCCCC");
        world.connect(bob);
        world.settle();
        assert_eq!(
            published_master(&world, "bob"),
            old_master,
            "a new device alone cannot replace the account's keys"
        );
        assert_ne!(local_master(&world.clients[bob]), old_master);

        // The wrong password: refused, and nothing moves on either side.
        let local_before = local_master(&world.clients[bob]);
        reset(&mut world, bob, "wrong horse");
        world.settle();
        assert_eq!(reset_failures(&world.clients[bob]), ["bad_password"]);
        assert_eq!(published_master(&world, "bob"), old_master);
        assert_eq!(local_master(&world.clients[bob]), local_before);
        assert!(
            world.clients[bob].core.device_id().is_some(),
            "a refused reset leaves encryption on"
        );

        // The right one: the server publishes new keys, this device holds and
        // is signed by them.
        reset(&mut world, bob, PASSWORD);
        world.settle();
        assert!(
            world.clients[bob]
                .events
                .iter()
                .any(|e| matches!(e, Event::CrossSigningReset))
        );
        let new_master = published_master(&world, "bob");
        assert_ne!(new_master, old_master);
        assert_eq!(local_master(&world.clients[bob]), new_master);
        let ssk = world.server.cross_signing["bob"]["selfSigning"]["key"]
            .as_str()
            .unwrap()
            .to_owned();
        let signatures = &world.server.devices["bob"]["CCCCCCCCCCCCCCCC"]["signatures"]["bob"];
        assert!(
            signatures.get(format!("ed25519:{ssk}")).is_some(),
            "the published device carries the new self-signing key's signature"
        );
        // The account's keys in the store survive a restart.
        let store = world.clients[bob].store.clone();
        let reopened = Client::restore("bob", "CCCCCCCCCCCCCCCC", store);
        assert_eq!(local_master(&reopened), new_master);

        // Alice hears of the change from `device-list-changed` alone — before
        // she writes anything — exactly once.
        let key_changed = |c: &Client| {
            c.events
                .iter()
                .filter(|e| matches!(e, Event::KeyChanged { peer } if peer.as_str() == "bob"))
                .count()
        };
        assert_eq!(key_changed(&world.clients[alice]), 1);

        // She holds, accepts — and the new device reads.
        world.send(alice, "bob", "m-2", "after the reset");
        world.settle();
        assert!(world.clients[alice].events.iter().any(|e| matches!(
            e,
            Event::KeyChanged { peer } if peer.as_str() == "bob"
        )));
        world.input(
            alice,
            Input::Action(Action::AcceptPeerKey { peer: login("bob") }),
        );
        world.settle();
        assert_eq!(
            row(&world.clients[bob], "alice", "m-2").text,
            "after the reset"
        );
        assert!(matches!(
            world.server.stored.last().unwrap().1.get("e2ee"),
            Some(Value::Object(_))
        ));
    }

    /// The reset reached the server but its answer did not reach the core:
    /// the account's published keys say it happened, and the device takes them.
    #[test]
    fn a_reset_whose_answer_was_lost_is_settled_from_the_published_keys() {
        let mut world = registered(&[("bob", "BBBBBBBBBBBBBBBB")]);
        let bob = world.index("bob", "BBBBBBBBBBBBBBBB");
        let old_master = published_master(&world, "bob");

        world.clients[bob].lose_next_answer = Some(true);
        reset(&mut world, bob, PASSWORD);
        world.settle();
        let new_master = published_master(&world, "bob");
        assert_ne!(new_master, old_master, "the server took it");
        // Reconnecting asks for the account's keys again.
        world.connect(bob);
        world.settle();
        assert!(
            world.clients[bob]
                .events
                .iter()
                .any(|e| matches!(e, Event::CrossSigningReset))
        );
        assert!(reset_failures(&world.clients[bob]).is_empty());
        assert_eq!(local_master(&world.clients[bob]), new_master);
        let ssk = world.server.cross_signing["bob"]["selfSigning"]["key"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(
            world.server.devices["bob"]["BBBBBBBBBBBBBBBB"]["signatures"]["bob"]
                .get(format!("ed25519:{ssk}"))
                .is_some(),
            "re-signed after settling, whatever went up on the new socket"
        );
    }

    /// The request never reached the server: the old keys stay, and the
    /// person hears the reset did not happen.
    #[test]
    fn a_reset_that_never_reached_the_server_leaves_the_old_keys_and_says_so() {
        let mut world = registered(&[("bob", "BBBBBBBBBBBBBBBB")]);
        let bob = world.index("bob", "BBBBBBBBBBBBBBBB");
        let old_master = published_master(&world, "bob");

        world.clients[bob].lose_next_answer = Some(false);
        reset(&mut world, bob, PASSWORD);
        world.settle();
        world.connect(bob);
        world.settle();
        assert_eq!(published_master(&world, "bob"), old_master);
        assert_eq!(local_master(&world.clients[bob]), old_master);
        assert_eq!(reset_failures(&world.clients[bob]), ["connection_lost"]);
        // And it can be asked again.
        reset(&mut world, bob, PASSWORD);
        world.settle();
        assert_ne!(published_master(&world, "bob"), old_master);
    }

    #[test]
    fn a_reset_is_refused_while_the_device_is_not_registered() {
        let mut world = World::new(vec![Client::new("bob", "BBBBBBBBBBBBBBBB")]);
        reset(&mut world, 0, PASSWORD);
        assert_eq!(reset_failures(&world.clients[0]), ["not_ready"]);
        assert!(world.clients[0].posts.is_empty());
    }

    // --- One request to every device (the live test, 2026-11-11) ----------
    //
    // A request went to the newest signed device by age — a switched-off one —
    // while the person sat at another. `StartSasAny` asks them all; the first
    // to answer takes the handshake, the rest are told `accepted_elsewhere`.

    fn started_tx(c: &Client, from: usize) -> String {
        c.events[from..]
            .iter()
            .find_map(|e| match e {
                Event::SasStarted { transaction_id, .. } => Some(transaction_id.clone()),
                _ => None,
            })
            .expect("SasStarted")
    }

    fn codes_since(c: &Client, from: usize) -> Vec<String> {
        c.events[from..]
            .iter()
            .filter_map(|e| match e {
                Event::SasCodeReady { transaction_id, .. } => Some(transaction_id.clone()),
                _ => None,
            })
            .collect()
    }

    fn start_any(world: &mut World, initiator: usize, peer: &str, devices: &[&str]) {
        world.input(
            initiator,
            Input::Action(Action::StartSasAny {
                peer: login(peer),
                devices: devices.iter().map(|d| (*d).to_owned()).collect(),
            }),
        );
        world.settle();
    }

    #[test]
    fn a_request_to_every_device_is_answered_by_the_one_that_is_on() {
        let mut world = registered(&[
            ("alice", "AAAAAAAAAAAAAAAA"),
            ("bob", "BOBOLDBOBOLDBOBO"),
            ("bob", "BOBNEWBOBNEWBOBN"),
        ]);
        let (alice, bob_off, bob_on) = (0, 1, 2);
        // The old device is "switched off": whatever it would answer never
        // leaves it — exactly the terminal nobody was running.
        world.clients[bob_off].deaf = true;
        let from: Vec<usize> = world.clients.iter().map(|c| c.events.len()).collect();

        start_any(
            &mut world,
            alice,
            "bob",
            &["BOBOLDBOBOLDBOBO", "BOBNEWBOBNEWBOBN"],
        );
        let tx = started_tx(&world.clients[alice], from[alice]);
        assert_eq!(
            codes_since(&world.clients[alice], from[alice]),
            std::slice::from_ref(&tx)
        );
        assert_eq!(
            codes_since(&world.clients[bob_on], from[bob_on]),
            std::slice::from_ref(&tx)
        );
        assert!(codes_since(&world.clients[bob_off], from[bob_off]).is_empty());
        // The device that lost is told why, in its own word, so its client can
        // stay silent instead of saying "cancelled on the other side".
        assert_eq!(
            cancels(&world.clients[bob_off], from[bob_off]),
            vec![(
                tx.clone(),
                "alice".into(),
                "AAAAAAAAAAAAAAAA".into(),
                "accepted_elsewhere".into()
            )],
        );

        for i in [alice, bob_on] {
            world.input(
                i,
                Input::Action(Action::ConfirmSas {
                    transaction_id: tx.clone(),
                }),
            );
        }
        world.settle();
        assert!(verified_since(&world.clients[alice], from[alice]));
        assert!(verified_since(&world.clients[bob_on], from[bob_on]));
    }

    #[test]
    fn when_two_devices_answer_the_first_takes_it_and_the_other_sees_nothing() {
        let mut world = registered(&[
            ("alice", "AAAAAAAAAAAAAAAA"),
            ("bob", "BOBONEBOBONEBOBO"),
            ("bob", "BOBTWOBOBTWOBOBT"),
        ]);
        let (alice, first, second) = (0, 1, 2);
        let from: Vec<usize> = world.clients.iter().map(|c| c.events.len()).collect();

        start_any(
            &mut world,
            alice,
            "bob",
            &["BOBONEBOBONEBOBO", "BOBTWOBOBTWOBOBT"],
        );
        let tx = started_tx(&world.clients[alice], from[alice]);
        // One code on alice's screen, never two to choose from.
        assert_eq!(
            codes_since(&world.clients[alice], from[alice]),
            std::slice::from_ref(&tx)
        );
        let shown: Vec<usize> = [first, second]
            .into_iter()
            .filter(|&i| !codes_since(&world.clients[i], from[i]).is_empty())
            .collect();
        assert_eq!(
            shown.len(),
            1,
            "exactly one of bob's devices shows the emojis"
        );
        let other = if shown[0] == first { second } else { first };
        assert_eq!(
            cancels(&world.clients[other], from[other])
                .into_iter()
                .map(|c| c.3)
                .collect::<Vec<_>>(),
            ["accepted_elsewhere"],
        );
        assert!(
            cancels(&world.clients[alice], from[alice]).is_empty(),
            "nothing failed for alice"
        );
    }

    #[test]
    fn cancelling_a_request_nobody_answered_tells_every_device_asked() {
        let mut world = registered(&[
            ("alice", "AAAAAAAAAAAAAAAA"),
            ("bob", "BOBONEBOBONEBOBO"),
            ("bob", "BOBTWOBOBTWOBOBT"),
        ]);
        let (alice, one, two) = (0, 1, 2);
        world.clients[one].deaf = true;
        world.clients[two].deaf = true;
        let from: Vec<usize> = world.clients.iter().map(|c| c.events.len()).collect();

        start_any(
            &mut world,
            alice,
            "bob",
            &["BOBONEBOBONEBOBO", "BOBTWOBOBTWOBOBT"],
        );
        let tx = started_tx(&world.clients[alice], from[alice]);
        assert!(codes_since(&world.clients[alice], from[alice]).is_empty());
        world.input(
            alice,
            Input::Action(Action::CancelSas {
                transaction_id: tx.clone(),
            }),
        );
        world.settle();
        for i in [one, two] {
            assert_eq!(
                cancels(&world.clients[i], from[i])
                    .into_iter()
                    .map(|c| (c.0, c.3))
                    .collect::<Vec<_>>(),
                vec![(tx.clone(), "user_cancelled".to_owned())],
                "a device switched off now must not pop the request up later",
            );
        }
    }

    #[test]
    fn a_start_with_one_device_still_works_as_before() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let tx = sas_until_code(&mut world, 0, 1);
        assert!(!tx.is_empty());
    }

    #[test]
    fn a_request_body_never_reaches_debug_output() {
        let request = ApiRequest {
            serial: 7,
            call: ApiCall::KeysUpload,
            body: format!(r#"{{"password":"{PASSWORD}"}}"#),
        };
        let shown = format!("{request:?}");
        assert!(!shown.contains(PASSWORD), "{shown}");
        assert!(shown.contains("bytes"), "{shown}");
    }

    /// `(status, [(login, emojis)], master_key, verified)` of one `SafetyCode`.
    type Code = (String, Vec<(String, Vec<u8>)>, String, bool);

    /// Every `SafetyCode` event `c` heard since `from`, about `peer`.
    fn safety_codes(c: &Client, from: usize, peer: &str) -> Vec<Code> {
        c.events[from..]
            .iter()
            .filter_map(|e| match e {
                Event::SafetyCode {
                    peer: p,
                    status,
                    halves,
                    master_key,
                    verified,
                    ..
                } if p.as_str() == peer => Some((
                    status.clone(),
                    halves
                        .iter()
                        .map(|h| (h.login.as_str().to_owned(), h.emoji_indices.clone()))
                        .collect(),
                    master_key.clone(),
                    *verified,
                )),
                _ => None,
            })
            .collect()
    }

    fn ask_safety(world: &mut World, i: usize, peer: &str) -> Code {
        let from = world.clients[i].events.len();
        world.input(i, Input::Action(Action::SafetyCode { peer: login(peer) }));
        world.settle();
        safety_codes(&world.clients[i], from, peer)
            .pop()
            .expect("a safety-code event")
    }

    // Owner, 2026-11-11: the emojis should always be there to look at, not only
    // for the 45 seconds both devices sit in a handshake.
    #[test]
    fn the_safety_code_is_the_same_on_both_sides_and_confirming_it_trusts_the_key() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        let bob = world.index("bob", "BBBBBBBBBBBBBBBB");

        let (status, mine, bob_master, verified) = ask_safety(&mut world, alice, "bob");
        assert_eq!(status, "ready");
        assert!(!verified, "trusted on first use, not verified");
        assert_eq!(bob_master, published_master(&world, "bob"));
        let (_, theirs, _, _) = ask_safety(&mut world, bob, "alice");
        assert_eq!(mine, theirs, "both people read the same twenty emojis");
        assert_eq!(mine[0].0, "alice");
        assert_eq!(mine[1].0, "bob");
        assert!(mine.iter().all(|(_, e)| e.len() == 10));

        // Your own account has no safety code with itself.
        let (status, ..) = ask_safety(&mut world, alice, "alice");
        assert_eq!(status, "unavailable");

        // A key that is not Bob's trusts nothing.
        let from = world.clients[alice].events.len();
        world.input(
            alice,
            Input::Action(Action::ConfirmSafetyCode {
                peer: login("bob"),
                master_key: published_master(&world, "alice"),
            }),
        );
        world.settle();
        assert!(!safety_codes(&world.clients[alice], from, "bob")[0].3);
        let pinned = &world.clients[alice].store.snapshot.peer_identities;
        assert!(
            pinned
                .iter()
                .any(|i| i.peer.as_str() == "bob" && !i.verified && i.master_key == bob_master),
            "the stored key is still Bob's own, unverified"
        );

        let from = world.clients[alice].events.len();
        world.input(
            alice,
            Input::Action(Action::ConfirmSafetyCode {
                peer: login("bob"),
                master_key: bob_master.clone(),
            }),
        );
        world.settle();
        assert!(safety_codes(&world.clients[alice], from, "bob")[0].3);
        let pinned = &world.clients[alice].store.snapshot.peer_identities;
        assert!(
            pinned
                .iter()
                .any(|i| i.peer.as_str() == "bob" && i.verified && i.master_key == bob_master)
        );

        // Bob resets his keys: his half changes, Alice's does not, nothing is
        // verified any more, and the code shown before the change confirms
        // nothing about the new key.
        world.server.cross_signing.remove("bob");
        world.server.devices.remove("bob");
        world.server.otks.retain(|(u, _), _| u != "bob");
        world.server.fallback.retain(|(u, _), _| u != "bob");
        world.clients[bob] = Client::new("bob", "BBBBBBBBBBBBBBBB");
        world.connect(bob);
        world.settle();
        let stored_before = world.server.stored.len();
        world.send(alice, "bob", "m-held", "after the reset");
        world.settle();
        assert_eq!(
            world.server.stored.len(),
            stored_before,
            "held on key change"
        );

        let (status, after, new_master, verified) = ask_safety(&mut world, alice, "bob");
        assert_eq!(status, "ready");
        assert_ne!(new_master, bob_master);
        assert!(!verified);
        assert_eq!(after[0], mine[0], "alice's half stays");
        assert_ne!(after[1], mine[1], "bob's new key shows");

        let from = world.clients[alice].events.len();
        world.input(
            alice,
            Input::Action(Action::ConfirmSafetyCode {
                peer: login("bob"),
                master_key: bob_master,
            }),
        );
        world.settle();
        assert!(
            !safety_codes(&world.clients[alice], from, "bob")[0].3,
            "the old code says nothing about the new key"
        );
        assert_eq!(world.server.stored.len(), stored_before, "still held");

        // The new code matched: the held message goes, to Bob's new keys.
        world.input(
            alice,
            Input::Action(Action::ConfirmSafetyCode {
                peer: login("bob"),
                master_key: new_master,
            }),
        );
        world.settle();
        assert_eq!(world.server.stored.len(), stored_before + 1);
        assert_eq!(
            row(&world.clients[bob], "alice", "m-held").text,
            "after the reset"
        );
    }

    /// Whether the server holds a statement of `who` about `peer` that the
    /// account's published keys check out — what any of its devices would
    /// adopt.
    fn vouched(world: &World, who: &str, peer: &str) -> Option<String> {
        let cross =
            tailchat_crypto::CrossSigningPublic::from_json(who, &world.server.cross_signing[who])
                .unwrap()
                .unwrap();
        let statement = world.server.trust.get(who)?.get(peer)?;
        cross.attested_peer(statement).map(|a| a.master_key)
    }

    fn confirm_code(world: &mut World, i: usize, peer: &str) {
        let (status, _, master, _) = ask_safety(world, i, peer);
        assert_eq!(status, "ready");
        world.input(
            i,
            Input::Action(Action::ConfirmSafetyCode {
                peer: login(peer),
                master_key: master,
            }),
        );
        world.settle();
    }

    // Owner, 2026-11-11: «но уже до этого approve делали. почему сейчас
    // снова» — the code was confirmed in the terminal, and the browser, a
    // device with its own store, had never heard of it.
    #[test]
    fn a_verification_made_on_one_device_holds_on_every_device_of_the_account() {
        let mut world = registered(&[
            ("alice", "AAAAAAAAAAAAAAAA"),
            ("alice", "CCCCCCCCCCCCCCCC"),
            ("bob", "BBBBBBBBBBBBBBBB"),
            ("carol", "DDDDDDDDDDDDDDDD"),
        ]);
        let terminal = world.index("alice", "AAAAAAAAAAAAAAAA");
        let browser = world.index("alice", "CCCCCCCCCCCCCCCC");
        let bob = world.index("bob", "BBBBBBBBBBBBBBBB");
        let bob_master = published_master(&world, "bob");

        // The browser has looked at Bob's code already: not verified.
        assert!(!ask_safety(&mut world, browser, "bob").3);

        // Alice compares the code in the terminal.
        let from = world.clients[browser].events.len();
        confirm_code(&mut world, terminal, "bob");
        assert_eq!(vouched(&world, "alice", "bob"), Some(bob_master.clone()));

        // The browser is told without asking (Details repaints), and it sticks.
        let told = safety_codes(&world.clients[browser], from, "bob");
        assert!(told.last().is_some_and(|c| c.3), "{told:?}");
        assert!(ask_safety(&mut world, browser, "bob").3);
        assert!(
            world.clients[browser]
                .store
                .snapshot
                .peer_identities
                .iter()
                .any(|i| i.peer.as_str() == "bob" && i.verified && i.master_key == bob_master)
        );
        // Bob's own account knows nothing of it: statements are per account.
        assert!(!world.server.trust.contains_key("bob"));

        // A device that starts afresh — a restart, a new tab — reads it too.
        let store = world.clients[browser].store.clone();
        world.clients[browser] = Client::restore("alice", "CCCCCCCCCCCCCCCC", store);
        world.connect(browser);
        world.settle();
        assert!(ask_safety(&mut world, browser, "bob").3);

        // The server cannot vouch on Alice's behalf: a statement made with
        // keys that are not her published ones is ignored.
        let carol_master = published_master(&world, "carol");
        let forged = tailchat_crypto::CrossSigning::new("alice")
            .unwrap()
            .attest_peer("carol", &carol_master)
            .unwrap();
        world
            .server
            .trust
            .get_mut("alice")
            .unwrap()
            .insert("carol".into(), forged);
        let notice = json!({"k": "device-list-changed", "login": "alice"}).to_string();
        world.clients[browser].incoming.push_back(notice);
        world.settle();
        assert!(!ask_safety(&mut world, browser, "carol").3);

        // Bob resets his keys: what Alice vouched for was the old key, so
        // neither device calls the new one verified.
        world.server.cross_signing.remove("bob");
        world.server.devices.remove("bob");
        world.server.otks.retain(|(u, _), _| u != "bob");
        world.server.fallback.retain(|(u, _), _| u != "bob");
        world.clients[bob] = Client::new("bob", "BBBBBBBBBBBBBBBB");
        world.connect(bob);
        world.settle();
        let new_master = published_master(&world, "bob");
        assert_ne!(new_master, bob_master);
        assert!(!ask_safety(&mut world, terminal, "bob").3);
        assert!(!ask_safety(&mut world, browser, "bob").3);

        // This time Alice compares in the browser: the terminal follows,
        // and its held key change is settled with it.
        confirm_code(&mut world, browser, "bob");
        assert_eq!(vouched(&world, "alice", "bob"), Some(new_master.clone()));
        assert!(ask_safety(&mut world, terminal, "bob").3);
        let stored_before = world.server.stored.len();
        world.send(terminal, "bob", "m-after", "verified elsewhere");
        world.settle();
        assert_eq!(world.server.stored.len(), stored_before + 1, "not held");
        assert_eq!(
            row(&world.clients[bob], "alice", "m-after").text,
            "verified elsewhere"
        );

        // Alice resets her own keys from the terminal: every statement the
        // old key signed is void, and the terminal signs again what it
        // verified, with the new key.
        reset(&mut world, terminal, PASSWORD);
        world.settle();
        assert!(reset_failures(&world.clients[terminal]).is_empty());
        assert_eq!(vouched(&world, "alice", "bob"), Some(new_master));
    }

    #[test]
    fn a_plain_picture_retry_stays_plain_after_an_e2ee_reconnect() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        world.input(alice, Input::Disconnected);
        world.input(alice, Input::Connected);
        world.input(
            alice,
            Input::Frame(
                json!({
                    "k":"ready", "users":[{"login":"bob"}], "caps":[]
                })
                .to_string(),
            ),
        );
        world.send_image(
            alice,
            "bob",
            "legacy-picture",
            "caption",
            "data:image/png;base64,AA==",
            (None, None),
        );
        let first = world.server.stored.last().unwrap().1.clone();
        assert!(first.get("e2ee").is_none());
        let queued = &world.clients[alice].store.snapshot.pending;
        assert_eq!(
            queued[0].seal,
            Seal::Plain,
            "the first send decides durably"
        );
        // The server committed, but the socket dies before its acceptance.
        world.clients[alice].incoming.clear();
        world.input(alice, Input::Disconnected);
        let saved = world.clients[alice].store.clone();
        world.clients[alice] = Client::restore("alice", "AAAAAAAAAAAAAAAA", saved);
        world.connect(alice);
        world.settle();
        let retries: Vec<_> = world
            .server
            .stored
            .iter()
            .filter(|(_, message)| message["id"] == "legacy-picture")
            .map(|(_, message)| message)
            .collect();
        assert!(retries.len() >= 2, "a retry reached the relay");
        assert!(
            retries.iter().all(|message| **message == first),
            "same id, same representation"
        );
    }

    #[test]
    fn an_escaped_id_is_included_in_picture_sealed_size_admission() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        let before = world.server.stored.len();
        let result = world.clients[alice].core.handle(
            Ts(world.now),
            Input::Action(Action::SendImage {
                id: MessageId::parse(&"\"".repeat(1024)).unwrap(),
                peer: login("bob"),
                text: "a".repeat(7_876_690),
                image: Image {
                    data_url: "data:image/png;base64,AA==".into(),
                    width: None,
                    height: None,
                },
            }),
        );
        assert!(matches!(
            result,
            Err(tailchat_core::CoreError::FrameTooLarge { .. })
        ));
        assert!(world.clients[alice].store.snapshot.pending.is_empty());
        assert_eq!(world.server.stored.len(), before);
    }

    /// A picture in an encrypted conversation: the bytes live inside the
    /// Megolm ciphertext, never in the frame the server keeps (spec E2EE §4.3).
    #[test]
    fn an_encrypted_picture_round_trips_and_the_wire_carries_no_base64() {
        const PICTURE: &str = "data:image/png;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        world.send_image(
            alice,
            "bob",
            "pic-1",
            "caption",
            PICTURE,
            (Some(3), Some(2)),
        );
        world.settle();

        // What the server holds: an envelope and neither the caption nor the
        // picture, and not one character of the picture's base64.
        let (_, stored) = &world.server.stored[0];
        assert!(stored.get("text").is_none(), "{stored}");
        assert!(stored.get("image").is_none(), "{stored}");
        let wire = stored.to_string();
        assert!(!wire.contains("caption"), "{wire}");
        assert!(!wire.contains("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo"));

        let bob = &world.clients[world.index("bob", "BBBBBBBBBBBBBBBB")];
        let message = row(bob, "alice", "pic-1");
        assert_eq!(message.text, "caption");
        assert_eq!(message.protection, Protection::Encrypted);
        let image = message.image.as_ref().expect("the picture arrived");
        assert_eq!(image.data_url, PICTURE);
        assert_eq!((image.width, image.height), (Some(3), Some(2)));
    }

    /// A picture still queued when the process dies is restored from the disk
    /// and re-sent under the same id, byte for byte, picture included.
    #[test]
    fn a_queued_picture_survives_a_restart_and_still_arrives_whole() {
        const PICTURE: &str = "data:image/webp;base64,QUJDREVGR0hJSktMTU5PUA==";
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        // A session in use, so the picture is sealed into an existing one.
        world.send(alice, "bob", "m-0", "zero");
        world.settle();
        let stored_before = world.server.stored.len();
        // Alice seals and persists, but nothing reaches the server.
        world.clients[alice].deaf = true;
        world.send_image(alice, "bob", "pic-1", "", PICTURE, (None, None));
        world.settle();
        let envelope = world.clients[alice]
            .store
            .snapshot
            .pending
            .iter()
            .find(|r| r.message.id.as_str() == "pic-1")
            .map(|r| r.seal.clone())
            .expect("the picture is queued");
        let Seal::Encrypted(envelope) = envelope else {
            panic!("sealed before the wire: {envelope:?}");
        };
        assert_eq!(world.server.stored.len(), stored_before);

        // Restart from the disk and let it go.
        let store = world.clients[alice].store.clone();
        world.clients[alice] = Client::restore("alice", "AAAAAAAAAAAAAAAA", store);
        world.connect(alice);
        world.settle();

        let sent = world
            .server
            .stored
            .iter()
            .find(|(_, d)| d["id"] == "pic-1")
            .map(|(_, d)| d)
            .expect("the picture went");
        assert_eq!(sent["e2ee"]["ct"], envelope.ct, "the same bytes");
        let bob = &world.clients[world.index("bob", "BBBBBBBBBBBBBBBB")];
        let message = row(bob, "alice", "pic-1");
        assert_eq!(message.text, "");
        assert_eq!(
            message.image.as_ref().map(|i| i.data_url.as_str()),
            Some(PICTURE)
        );
    }

    /// An encrypted header that does not describe a complete picture leaves
    /// the message intact: the text is kept and the picture is dropped, never
    /// the whole row and never a panic.
    #[test]
    fn a_malformed_encrypted_picture_keeps_the_text() {
        use tailchat_crypto::{Account, Frame, MessageKind as Kind, OutboundGroup};

        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        let bob = world.index("bob", "BBBBBBBBBBBBBBBB");
        // One real message first: it creates the session and shares its key.
        world.send(alice, "bob", "m-0", "hello");
        world.settle();

        // Alice's own sending session and account, as the disk holds them.
        let store = &world.clients[alice].store;
        let account = Account::from_pickle(
            store
                .snapshot
                .crypto_account
                .as_ref()
                .expect("registered")
                .expose(),
        )
        .expect("account");
        let pickle = &store
            .snapshot
            .outbound_groups
            .iter()
            .find(|g| g.peer.as_str() == "bob")
            .expect("session with bob")
            .pickle;
        let mut group = OutboundGroup::from_pickle(pickle.expose()).expect("group");

        let mut seal = |id: &str, content: Value, blob: Option<&[u8]>| {
            let frame = Frame {
                from: "alice",
                to: "bob",
                id,
                kind: Kind::Msg,
            };
            let content = content.as_object().expect("header object").clone();
            let sealed = group
                .encrypt(&account, &frame, &content, blob)
                .expect("encrypts");
            let relayed = json!({
                "k": "frame",
                "from": "alice",
                "d": {
                    "t": "msg",
                    "id": id,
                    "ts": world.now,
                    "e2ee": {"v": 1, "dev": sealed.dev, "sid": sealed.sid, "ct": sealed.ct},
                }
            });
            world.input(bob, Input::Frame(relayed.to_string()));
        };

        // No bytes at all: the text stays, the picture is gone.
        seal(
            "bad-1",
            json!({"text": "no bytes", "image": {"mime": "image/webp"}}),
            None,
        );
        // A type the server would never have taken from an open frame.
        seal(
            "bad-2",
            json!({"text": "bad type", "image": {"mime": "image/svg+xml"}}),
            Some(b"xyz"),
        );
        // Bytes without a picture header: nothing to draw.
        seal("bad-3", json!({"text": "no header"}), Some(b"xyz"));
        // The well-formed pair is what the rule exists for.
        seal(
            "good-1",
            json!({"text": "ok", "image": {"mime": "image/png", "width": 7}}),
            Some(b"xyz"),
        );
        world.settle();

        for (id, text) in [
            ("bad-1", "no bytes"),
            ("bad-2", "bad type"),
            ("bad-3", "no header"),
        ] {
            let message = row(&world.clients[bob], "alice", id);
            assert_eq!(message.text, text, "{id} keeps its text");
            assert!(message.image.is_none(), "{id} has no picture");
            assert_eq!(message.protection, Protection::Encrypted);
        }
        let good = row(&world.clients[bob], "alice", "good-1");
        assert_eq!(good.text, "ok");
        let image = good.image.as_ref().expect("the picture");
        assert_eq!(image.data_url, "data:image/png;base64,eHl6");
        assert_eq!((image.width, image.height), (Some(7), None));
    }

    fn send_with(world: &mut World, i: usize, to: &str, id: &str, text: &str, extra: Extra) {
        world.input(
            i,
            Input::Action(Action::SendWith {
                id: MessageId::parse(id).unwrap(),
                peer: login(to),
                text: text.into(),
                image: None,
                extra: Box::new(extra),
            }),
        );
    }

    fn edit(world: &mut World, i: usize, to: &str, id: &str, target: &str, text: &str) {
        world.input(
            i,
            Input::Action(Action::EditText {
                id: MessageId::parse(id).unwrap(),
                peer: login(to),
                target: MessageId::parse(target).unwrap(),
                text: text.into(),
            }),
        );
    }

    /// A quote and a forward label in an encrypted conversation travel inside
    /// the ciphertext: the server holds neither the quoted words nor the
    /// original author's name, and the reader gets both.
    #[test]
    fn a_reply_and_a_forward_travel_sealed() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        let bob = world.index("bob", "BBBBBBBBBBBBBBBB");
        world.send(bob, "alice", "m-0", "цитируемое слово");
        world.settle();
        let quote = Reply {
            id: MessageId::parse("m-0").unwrap(),
            from: login("bob"),
            text: "цитируемое слово".into(),
            media: None,
        };
        send_with(
            &mut world,
            alice,
            "bob",
            "m-1",
            "ответ",
            Extra {
                reply_to: Some(quote.clone()),
                forwarded_from: Some(Forwarded {
                    login: Some(login("carol")),
                    name: Some("Кэрол".into()),
                }),
                ..Extra::default()
            },
        );
        world.settle();
        let (_, stored) = world
            .server
            .stored
            .iter()
            .find(|(_, d)| d["id"] == "m-1")
            .expect("stored");
        let wire = stored.to_string();
        assert!(stored.get("replyTo").is_none(), "{wire}");
        assert!(stored.get("forwardedFrom").is_none(), "{wire}");
        for secret in ["цитируемое", "ответ", "carol", "Кэрол"] {
            assert!(!wire.contains(secret), "{secret} in {wire}");
        }
        let got = row(&world.clients[bob], "alice", "m-1");
        assert_eq!(got.text, "ответ");
        assert_eq!(got.reply_to.as_ref(), Some(&quote));
        let forwarded = got.forwarded_from.as_ref().expect("label");
        assert_eq!(forwarded.name.as_deref(), Some("Кэрол"));
        assert_eq!(got.protection, Protection::Encrypted);
    }

    /// An edit in an encrypted conversation is an encrypted message naming
    /// its target: the server never sees the new words, the reader's copy of
    /// the target changes, and the carrier row stays, marked as an edit.
    #[test]
    fn an_encrypted_edit_never_shows_its_text_to_the_server() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        let bob = world.index("bob", "BBBBBBBBBBBBBBBB");
        world.send(alice, "bob", "m-1", "старый текст");
        world.settle();
        edit(&mut world, alice, "bob", "e-1", "m-1", "новый текст");
        world.settle();

        let wire = world
            .server
            .stored
            .iter()
            .map(|(_, d)| d.to_string())
            .collect::<String>();
        assert!(!wire.contains("новый"), "{wire}");
        assert!(!wire.contains("editOf"), "{wire}");
        // The one open bit: the carrier says it is an edit (so the server
        // neither counts it unread nor pushes it), never which message.
        let frame = |id: &str| {
            world
                .server
                .stored
                .iter()
                .find(|(_, d)| d["id"] == id)
                .map(|(_, d)| d.clone())
                .expect("stored")
        };
        let carrier = frame("e-1");
        assert_eq!(
            carrier["sealedEdit"],
            serde_json::Value::Bool(true),
            "{carrier}"
        );
        assert!(!carrier.to_string().contains("m-1"), "{carrier}");
        assert!(
            frame("m-1").get("sealedEdit").is_none(),
            "an ordinary message has no flag"
        );

        let target = row(&world.clients[bob], "alice", "m-1");
        assert_eq!(target.text, "новый текст");
        assert!(target.edited_at.is_some());
        let carrier = row(&world.clients[bob], "alice", "e-1");
        assert_eq!(carrier.edit_of.as_ref().map(MessageId::as_str), Some("m-1"));

        let mine = &world.clients[alice].store;
        let sent = mine
            .snapshot
            .sent
            .iter()
            .find(|m| m.id.as_str() == "m-1")
            .expect("sent");
        assert_eq!(sent.text, "новый текст");
        let carrier = mine
            .snapshot
            .sent
            .iter()
            .find(|m| m.id.as_str() == "e-1")
            .expect("the carrier is a committed row of its own");
        assert_eq!(
            carrier.extra.edit_of.as_ref().map(MessageId::as_str),
            Some("m-1")
        );
    }

    /// Only a message's author can edit it: an encrypted edit from the other
    /// side naming somebody else's message changes nothing anywhere.
    #[test]
    fn an_encrypted_edit_of_somebody_elses_message_is_ignored() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        let bob = world.index("bob", "BBBBBBBBBBBBBBBB");
        world.send(alice, "bob", "m-1", "моё");
        world.send(bob, "alice", "m-2", "твоё");
        world.settle();
        edit(&mut world, bob, "alice", "e-1", "m-1", "подделка");
        world.settle();
        assert_eq!(row(&world.clients[bob], "alice", "m-1").text, "моё");
        let sent = world.clients[alice]
            .store
            .snapshot
            .sent
            .iter()
            .find(|m| m.id.as_str() == "m-1")
            .expect("sent")
            .text
            .clone();
        assert_eq!(sent, "моё");
        // An open frame can never be an edit, whatever it claims.
        let open = json!({"k":"frame","from":"bob","d":{"t":"msg","id":"o-1","ts":world.now,"text":"x","editOf":"m-2"}});
        world.input(alice, Input::Frame(open.to_string()));
        assert_eq!(row(&world.clients[alice], "bob", "m-2").text, "твоё");
        assert!(row(&world.clients[alice], "bob", "o-1").edit_of.is_none());
    }

    /// A voice note in an encrypted conversation: its bytes are the
    /// ciphertext's blob, its length and waveform are in the header, and the
    /// reader gets the same bytes back.
    #[test]
    fn an_encrypted_voice_note_round_trips_and_the_wire_carries_no_base64() {
        const VOICE: &str = "data:audio/mp4;base64,QUFDQkFDQ0FBQ0NCQUNDQUFDQ0JBQ0NB";
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let alice = world.index("alice", "AAAAAAAAAAAAAAAA");
        let bob = world.index("bob", "BBBBBBBBBBBBBBBB");
        send_with(
            &mut world,
            alice,
            "bob",
            "v-1",
            "🎙 Голосовое сообщение (0:02)",
            Extra {
                voice: Some(OutVoice {
                    data_url: VOICE.into(),
                    duration_ms: 2500,
                    waveform: vec![0, 128, 255],
                }),
                ..Extra::default()
            },
        );
        world.settle();
        let (_, stored) = world
            .server
            .stored
            .iter()
            .find(|(_, d)| d["id"] == "v-1")
            .expect("stored");
        let wire = stored.to_string();
        assert!(stored.get("voice").is_none(), "{wire}");
        assert!(!wire.contains("QUFDQkFD"), "{wire}");
        let got = row(&world.clients[bob], "alice", "v-1");
        let voice = got.voice.as_ref().expect("the voice note arrived");
        assert_eq!(voice.data_url, VOICE);
        assert_eq!(voice.duration, Some(2.5));
        assert_eq!(voice.waveform.as_deref(), Some(&[0, 128, 255][..]));
        assert_eq!(got.protection, Protection::Encrypted);
    }

    // ---- R3: cores from before the blob (1.146 and older) ----------------

    /// Opens `id` the way a core from before 1.148 did: the reader's own
    /// inbound session, then the header read as the body straight away —
    /// no `attach_media`, the bytes after the header ignored. Returns that
    /// body and whether the ciphertext carried bytes at all.
    fn open_as_old_core(
        world: &World,
        reader: usize,
        author: &str,
        to: &str,
        id: &str,
    ) -> (tailchat_core::frames::inner::MessageBody, bool) {
        use tailchat_crypto::{Envelope, Frame, InboundGroup, MessageKind as Kind};
        let (_, d) = world
            .server
            .stored
            .iter()
            .find(|(_, d)| d["id"] == id)
            .expect("stored");
        let e2ee = &d["e2ee"];
        let sid = e2ee["sid"].as_str().unwrap();
        let row = world.clients[reader]
            .store
            .snapshot
            .inbound_groups
            .iter()
            .find(|g| g.session == sid)
            .expect("the reader holds the session");
        let mut group = InboundGroup::from_pickle(row.pickle.expose()).unwrap();
        let frame = Frame {
            from: author,
            to,
            id,
            kind: Kind::Msg,
        };
        let envelope = Envelope {
            dev: e2ee["dev"].as_str().unwrap().to_owned(),
            sid: sid.to_owned(),
            ct: e2ee["ct"].as_str().unwrap().to_owned(),
        };
        let decrypted = group.decrypt(&frame, &envelope, None).unwrap();
        let body = serde_json::from_value(Value::Object(decrypted.content)).unwrap();
        (body, decrypted.blob.is_some_and(|b| !b.is_empty()))
    }

    /// A device whose core never announced the blob: from its next upload on
    /// the server lists no `caps` for it, the way it lists a 1.146 device,
    /// and tells everyone the list changed.
    fn act_old(world: &mut World, login: &str, device: &str) {
        world
            .server
            .old
            .insert((login.to_owned(), device.to_owned()));
    }

    const R3_PICTURE: &str = "data:image/png;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";
    const R3_VOICE_OK: &str = "data:audio/webm;base64,R0hJSktMTU5PUFFSU1RV";

    fn voice_extra(data_url: &str) -> Extra {
        Extra {
            voice: Some(OutVoice {
                data_url: data_url.into(),
                duration_ms: 1500,
                waveform: vec![1, 2, 3],
            }),
            ..Extra::default()
        }
    }

    /// With a reader that never announced the blob, the picture and the voice
    /// note travel as the `dataUrl` inside the ciphertext: the old core's own
    /// reading finds them, the new core's too, and the server still holds
    /// nothing but envelopes.
    #[test]
    fn a_reader_without_the_blob_cap_gets_pictures_and_voice_it_can_read() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        act_old(&mut world, "bob", "BBBBBBBBBBBBBBBB");
        let (alice, bob) = (0, 1);
        // The device list as it is now: bob re-announces without the cap.
        world.connect(bob);
        world.settle();
        world.send_image(
            alice,
            "bob",
            "pic-old",
            "caption",
            R3_PICTURE,
            (Some(3), Some(2)),
        );
        send_with(
            &mut world,
            alice,
            "bob",
            "v-old",
            "🎙 (0:01)",
            voice_extra(R3_VOICE_OK),
        );
        world.settle();

        for id in ["pic-old", "v-old"] {
            let (_, stored) = world
                .server
                .stored
                .iter()
                .find(|(_, d)| d["id"] == id)
                .unwrap();
            let wire = stored.to_string();
            assert!(
                stored.get("image").is_none() && stored.get("voice").is_none(),
                "{wire}"
            );
            assert!(!wire.contains("QUJDREVGR0hJSktMTU5PUFFS"), "{wire}");
            assert!(!wire.contains("R0hJSktMTU5PUFFSU1RV"), "{wire}");
        }
        let (old, blob) = open_as_old_core(&world, bob, "alice", "bob", "pic-old");
        assert!(!blob, "no bytes after the header");
        assert_eq!(old.text, "caption");
        let image = old.image.expect("the old core reads the picture");
        assert_eq!(image.data_url, R3_PICTURE);
        assert_eq!((image.width, image.height), (Some(3), Some(2)));
        let (old, blob) = open_as_old_core(&world, bob, "alice", "bob", "v-old");
        assert!(!blob);
        let voice = old.voice.expect("the old core reads the voice note");
        assert_eq!(voice.data_url, R3_VOICE_OK);
        assert_eq!(voice.duration, Some(1.5));

        let got = row(&world.clients[bob], "alice", "pic-old");
        assert_eq!(
            got.image.as_ref().map(|i| i.data_url.as_str()),
            Some(R3_PICTURE)
        );
        assert!(!got.media_dropped);
        let got = row(&world.clients[bob], "alice", "v-old");
        assert_eq!(
            got.voice.as_ref().map(|v| v.data_url.as_str()),
            Some(R3_VOICE_OK)
        );
        assert_eq!(got.protection, Protection::Encrypted);
    }

    /// Every device announced the blob: the bytes go after the header, which
    /// is exactly what an old core could not read — the reason for the rule.
    #[test]
    fn when_every_device_reads_the_blob_the_bytes_go_after_the_header() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let (alice, bob) = (0, 1);
        world.send_image(alice, "bob", "pic-new", "caption", R3_PICTURE, (None, None));
        world.settle();
        let (old, blob) = open_as_old_core(&world, bob, "alice", "bob", "pic-new");
        assert!(blob, "the picture's bytes follow the header");
        assert!(old.image.is_none(), "an old core would have lost it");
        let got = row(&world.clients[bob], "alice", "pic-new");
        assert_eq!(
            got.image.as_ref().map(|i| i.data_url.as_str()),
            Some(R3_PICTURE)
        );
    }

    /// The author's other device keeps its own copy: one old device of the
    /// sender's account is enough for the inline form.
    #[test]
    fn an_old_device_of_the_author_also_gets_the_inline_form() {
        let mut world = registered(&[
            ("alice", "AAAAAAAAAAAAAAAA"),
            ("alice", "A2A2A2A2A2A2A2A2"),
            ("bob", "BBBBBBBBBBBBBBBB"),
        ]);
        act_old(&mut world, "alice", "A2A2A2A2A2A2A2A2");
        world.connect(1);
        world.settle();
        world.send_image(0, "bob", "pic-self", "", R3_PICTURE, (None, None));
        world.settle();
        let (old, blob) = open_as_old_core(&world, 1, "alice", "bob", "pic-self");
        assert!(!blob);
        assert_eq!(old.image.map(|i| i.data_url), Some(R3_PICTURE.to_owned()));
        let got = row(&world.clients[2], "alice", "pic-self");
        assert_eq!(
            got.image.as_ref().map(|i| i.data_url.as_str()),
            Some(R3_PICTURE)
        );
    }

    /// The inline form is a third larger. When it does not fit one frame the
    /// picture fails here, before the wire, with `peer_outdated` — never
    /// sealed as bytes the old device would drop while saying "delivered".
    /// Once the reader announces the blob, "retry" sends it.
    #[test]
    fn a_picture_too_large_for_an_old_reader_fails_before_the_wire_and_retry_sends_it() {
        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        act_old(&mut world, "bob", "BBBBBBBBBBBBBBBB");
        let (alice, bob) = (0, 1);
        world.connect(bob);
        world.send(alice, "bob", "m-0", "hello");
        world.settle();
        // 6 MiB of picture: ~8 MiB of ciphertext as bytes, ~10.7 MiB inline.
        let big = format!("data:image/jpeg;base64,{}", "AAAA".repeat(2 * 1024 * 1024));
        let before = world.server.stored.len();
        world.send_image(alice, "bob", "pic-big", "", &big, (None, None));
        world.settle();
        assert_eq!(world.server.stored.len(), before, "nothing went");
        let events = &world.clients[alice].events;
        assert!(
            events.iter().any(|e| matches!(e,
            Event::ServerError { code, id: Some(id), .. }
                if code == tailchat_core::frames::e2ee::PEER_OUTDATED && id.as_str() == "pic-big"))
        );
        assert!(events.iter().any(|e| matches!(e,
            Event::ReceiptChanged { id, receipt: Receipt::Failed, .. } if id.as_str() == "pic-big")));
        let pending = world.clients[alice]
            .store
            .snapshot
            .pending
            .iter()
            .find(|r| r.message.id.as_str() == "pic-big")
            .expect("kept for retry");
        assert_eq!(pending.seal, Seal::Undecided);

        // Bob updates: his device announces the blob, and the list changes.
        world.server.old.clear();
        world.connect(bob);
        world.settle();
        world.input(
            alice,
            Input::Action(Action::Retry {
                peer: login("bob"),
                id: MessageId::parse("pic-big").unwrap(),
            }),
        );
        world.settle();
        let got = row(&world.clients[bob], "alice", "pic-big");
        assert_eq!(
            got.image.as_ref().map(|i| i.data_url.len()),
            Some(big.len())
        );
    }

    /// (c) A sealed attachment this core cannot put back — a newer sender's
    /// form — keeps the caption, says `media_dropped`, and is not
    /// acknowledged: the sender keeps ✓ instead of a ✓✓ that hides the loss.
    #[test]
    fn an_attachment_this_core_cannot_read_is_marked_and_not_acknowledged() {
        use tailchat_crypto::{Account, Frame, MessageKind as Kind, OutboundGroup};

        let mut world = registered(&[("alice", "AAAAAAAAAAAAAAAA"), ("bob", "BBBBBBBBBBBBBBBB")]);
        let (alice, bob) = (0, 1);
        world.send(alice, "bob", "m-0", "hello");
        world.settle();
        assert!(
            world
                .server
                .acks
                .iter()
                .any(|(who, d)| who == "bob" && d["id"] == "m-0")
        );

        let store = &world.clients[alice].store;
        let account =
            Account::from_pickle(store.snapshot.crypto_account.as_ref().unwrap().expose()).unwrap();
        let pickle = &store
            .snapshot
            .outbound_groups
            .iter()
            .find(|g| g.peer.as_str() == "bob")
            .unwrap()
            .pickle;
        let mut group = OutboundGroup::from_pickle(pickle.expose()).unwrap();
        let mut seal = |world: &mut World, id: &str, content: Value, blob: Option<&[u8]>| {
            let frame = Frame {
                from: "alice",
                to: "bob",
                id,
                kind: Kind::Msg,
            };
            let content = content.as_object().unwrap().clone();
            let sealed = group.encrypt(&account, &frame, &content, blob).unwrap();
            world.now += 1;
            let relayed = json!({"k": "frame", "from": "alice", "d": {
                "t": "msg", "id": id, "ts": world.now,
                "e2ee": {"v": 1, "dev": sealed.dev, "sid": sealed.sid, "ct": sealed.ct},
            }});
            world.input(bob, Input::Frame(relayed.to_string()));
            world.settle();
        };
        // A picture by reference, and bytes under a key nobody here knows.
        seal(
            &mut world,
            "new-1",
            json!({"text": "by ref", "image": {"ref": "x"}}),
            None,
        );
        seal(
            &mut world,
            "new-2",
            json!({"text": "a file", "file": {"name": "a"}}),
            Some(b"xyz"),
        );
        // An inline voice note this core does read, for contrast.
        seal(
            &mut world,
            "ok-1",
            json!({"text": "voice", "voice": {"dataUrl": R3_VOICE_OK, "duration": 1.0}}),
            None,
        );
        for id in ["new-1", "new-2"] {
            let got = row(&world.clients[bob], "alice", id);
            assert!(got.media_dropped, "{id} says its attachment is gone");
            assert!(got.image.is_none() && got.voice.is_none());
            assert!(
                !world
                    .server
                    .acks
                    .iter()
                    .any(|(who, d)| who == "bob" && d["id"] == id),
                "{id} is not acknowledged"
            );
        }
        let ok = row(&world.clients[bob], "alice", "ok-1");
        assert!(!ok.media_dropped);
        assert_eq!(
            ok.voice.as_ref().map(|v| v.data_url.as_str()),
            Some(R3_VOICE_OK)
        );
        assert!(
            world
                .server
                .acks
                .iter()
                .any(|(who, d)| who == "bob" && d["id"] == "ok-1")
        );
    }
}
