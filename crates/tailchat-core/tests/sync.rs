//! Stage 3: the account feed and `/api/history` against a model of the
//! server's own rules (`accounts.js` `eventsSince` and `history`), with a
//! real `Storage` in between and restarts wherever a crash would hurt.

mod common;

#[cfg(test)]
mod cases {
    use std::collections::{BTreeMap, HashMap, VecDeque};

    use serde_json::{Value, json};
    use tailchat_core::{
        Action, Below, Core, Event, FetchError, HistoryRequest, Input, Login, MessageId, Output,
        Receipt, Storage, StoreOp, Token, Ts,
    };

    use super::common::MemStore;

    const ME: &str = "alice";

    /// One row as both sides compare it: id, text, edit time, reactions.
    type Row = (String, String, Option<i64>, Vec<(String, Vec<String>)>);

    fn login(s: &str) -> Login {
        Login::parse(s).unwrap()
    }
    fn id(s: &str) -> MessageId {
        MessageId::parse(s).unwrap()
    }

    // ------------------------------------------------------------ the server

    #[derive(Debug, Clone)]
    struct Record {
        id: String,
        from: String,
        ts: i64,
        text: String,
        edited_at: Option<i64>,
        deleted_at: Option<i64>,
        reactions: BTreeMap<String, Vec<String>>,
    }

    /// Alice's side of the server: her feed and her conversations.
    struct Server {
        clock: i64,
        seq: i64,
        window: usize,
        feed: Vec<Value>,
        history: BTreeMap<String, Vec<Record>>,
        peer_read: HashMap<String, i64>,
        /// What alice's `ack`s told the server her device holds.
        delivered: HashMap<String, i64>,
    }

    impl Server {
        fn new(window: usize) -> Self {
            Self {
                clock: 1_000,
                seq: 0,
                window,
                feed: Vec::new(),
                history: BTreeMap::new(),
                peer_read: HashMap::new(),
                delivered: HashMap::new(),
            }
        }

        /// The next feed event; other accounts' events take numbers too.
        fn event(&mut self, mut event: Value) {
            self.seq += 3;
            event["seq"] = json!(self.seq);
            self.feed.push(event);
            while self.feed.len() > self.window {
                self.feed.remove(0);
            }
        }

        fn records(&mut self, peer: &str) -> &mut Vec<Record> {
            self.history.entry(peer.to_owned()).or_default()
        }

        /// A message in the conversation with `peer`; `from` is `peer` or
        /// alice on another device. `same_ts` keeps the clock, like a burst
        /// of queued frames the server stores under one time.
        fn message(&mut self, peer: &str, from: &str, mid: &str, same_ts: bool) {
            if !same_ts {
                self.clock += 1;
            }
            let ts = self.clock;
            self.records(peer).push(Record {
                id: mid.into(),
                from: from.into(),
                ts,
                text: format!("text of {mid}"),
                edited_at: None,
                deleted_at: None,
                reactions: BTreeMap::new(),
            });
            let mut event = json!({"kind":"message","peer":peer,"id":mid,"ts":ts,"from":from});
            if from == ME {
                event["self"] = json!(true);
            }
            self.event(event);
        }

        fn burst(&mut self, peer: &str, prefix: &str, count: usize) {
            for n in 0..count {
                // Ten messages per millisecond: ties the walk must page through.
                self.message(peer, peer, &format!("{prefix}-{n:04}"), n % 10 != 0);
            }
        }

        fn find(&mut self, peer: &str, mid: &str) -> &mut Record {
            self.records(peer).iter_mut().find(|r| r.id == mid).unwrap()
        }

        fn edit(&mut self, peer: &str, mid: &str, text: &str) {
            self.clock += 1;
            let at = self.clock;
            let record = self.find(peer, mid);
            record.text = text.into();
            record.edited_at = Some(at);
            self.event(json!({"kind":"edit","peer":peer,"id":mid,"text":text,"ts":at}));
        }

        fn delete(&mut self, peer: &str, mid: &str) {
            self.clock += 1;
            let at = self.clock;
            let record = self.find(peer, mid);
            record.deleted_at = Some(at);
            record.text.clear();
            record.reactions.clear();
            self.event(json!({"kind":"delete","peer":peer,"ids":[mid],"scope":"all"}));
        }

        fn react(&mut self, peer: &str, mid: &str, emoji: &str, by: &str, add: bool) {
            let record = self.find(peer, mid);
            let members = record.reactions.entry(emoji.into()).or_default();
            members.retain(|m| m != by);
            if add {
                members.push(by.into());
            }
            if members.is_empty() {
                record.reactions.remove(emoji);
            }
            let mut event =
                json!({"kind":"react","peer":peer,"id":mid,"emoji":emoji,"by":by,"add":add});
            if by == ME {
                event["self"] = json!(true);
            }
            self.event(event);
        }

        /// `peer` read alice's messages up to `ts`, or alice read theirs.
        fn read(&mut self, peer: &str, reader: &str, ts: i64) {
            if reader != ME {
                self.peer_read.insert(peer.into(), ts);
            }
            let mut event = json!({"kind":"read","peer":peer,"readTs":ts,"ts":ts});
            if reader == ME {
                event["self"] = json!(true);
            }
            self.event(event);
        }

        /// `eventsSince`.
        fn sync_page(&self, since: i64, limit: usize) -> String {
            let oldest = self.feed.first().map_or(0, |e| e["seq"].as_i64().unwrap());
            let reset = since > 0 && since < oldest;
            let start = if reset {
                0
            } else {
                self.feed
                    .iter()
                    .position(|e| e["seq"].as_i64().unwrap() > since)
                    .unwrap_or(self.feed.len())
            };
            let remaining = &self.feed[start..];
            let events: Vec<Value> = remaining.iter().take(limit.min(500)).cloned().collect();
            let cursor = events.last().map_or(since, |e| e["seq"].as_i64().unwrap());
            json!({
                "k":"sync-page","events":events,"cursor":cursor,
                "more": remaining.len() > events.len(),"reset":reset,
            })
            .to_string()
        }

        /// `history` with `deleted=1`.
        fn history(&self, request: &HistoryRequest) -> String {
            let mut sorted: Vec<&Record> = self
                .history
                .get(request.peer.as_str())
                .map(|records| records.iter().collect())
                .unwrap_or_default();
            sorted.sort_by_key(|r| r.ts);
            if let Some(below) = &request.below {
                match sorted.iter().position(|r| r.id == below.id.as_str()) {
                    Some(index) => sorted.truncate(index),
                    None => sorted.retain(|r| r.ts < below.ts.0),
                }
            }
            let limit = usize::from(request.limit);
            let page = &sorted[sorted.len().saturating_sub(limit)..];
            let messages: Vec<Value> = page
                .iter()
                .map(|r| {
                    let mut value = json!({
                        "id":r.id,"from":r.from,"text":r.text,"ts":r.ts,"kind":"human",
                    });
                    if let Some(at) = r.edited_at {
                        value["editedAt"] = json!(at);
                    }
                    if let Some(at) = r.deleted_at {
                        value["deletedAt"] = json!(at);
                    }
                    if !r.reactions.is_empty() {
                        value["reactions"] = json!(r.reactions);
                    }
                    value
                })
                .collect();
            json!({
                "messages":messages,
                "peerReadTs":self.peer_read.get(request.peer.as_str()).copied().unwrap_or(0),
                "peerDeliveredTs":0,
            })
            .to_string()
        }

        /// What alice should hold for `peer`: every record not deleted.
        fn visible(&self, peer: &str) -> Vec<Row> {
            let mut records: Vec<&Record> = self.history[peer]
                .iter()
                .filter(|r| r.deleted_at.is_none())
                .collect();
            records.sort_by(|a, b| (a.ts, &a.id).cmp(&(b.ts, &b.id)));
            records
                .into_iter()
                .map(|r| {
                    let reactions = r
                        .reactions
                        .iter()
                        .map(|(e, by)| (e.clone(), by.clone()))
                        .collect();
                    (r.id.clone(), r.text.clone(), r.edited_at, reactions)
                })
                .collect()
        }
    }

    // ------------------------------------------------------------ the driver

    /// A driver: carries out every output, answers `sync` from the model and,
    /// while `auto` is on, every fetch too.
    struct Harness {
        core: Core,
        store: MemStore,
        server: Server,
        now: i64,
        auto: bool,
        inputs: VecDeque<Input>,
        /// Fetches not answered yet (with `auto` off).
        fetches: Vec<HistoryRequest>,
        fetched: usize,
        /// Every `ack` written, in order.
        acks: Vec<(String, String)>,
        /// Every frame written, as JSON.
        wire: Vec<Value>,
        /// How many times each key was inserted as a new row.
        stored: HashMap<(String, String), usize>,
        events: Vec<Event>,
    }

    fn ready() -> String {
        json!({
            "k":"ready","self":{"login":ME},
            "users":[{"login":"bob"},{"login":"carol"}],
            "caps":["durable-ack","sync-v1","addressed-send","sync-nudge-v1"],
        })
        .to_string()
    }

    fn token() -> Token {
        Token::parse(&"a".repeat(64)).unwrap()
    }

    impl Harness {
        fn new(server: Server) -> Self {
            let store = MemStore::default();
            Self {
                core: Core::new(login(ME), token(), store.load().unwrap()),
                store,
                server,
                now: 10_000,
                auto: true,
                inputs: VecDeque::new(),
                fetches: Vec::new(),
                fetched: 0,
                acks: Vec::new(),
                wire: Vec::new(),
                stored: HashMap::new(),
                events: Vec::new(),
            }
        }

        /// A process restart: everything in memory is gone.
        fn restart(&mut self) {
            self.inputs.clear();
            self.fetches.clear();
            self.core = Core::new(login(ME), token(), self.store.load().unwrap());
        }

        fn connect(&mut self) {
            self.input(Input::Connected);
            self.input(Input::Frame(ready()));
        }

        fn disconnect(&mut self) {
            self.input(Input::Disconnected);
        }

        fn frame(&mut self, raw: &str) {
            self.input(Input::Frame(raw.into()));
        }

        /// The server's "your feed moved".
        fn nudge(&mut self) {
            self.frame(r#"{"k":"sync-nudge"}"#);
        }

        fn input(&mut self, input: Input) {
            self.inputs.push_back(input);
            self.pump();
        }

        fn pump(&mut self) {
            while let Some(input) = self.inputs.pop_front() {
                let outputs = self.core.handle(Ts(self.now), input).unwrap();
                self.carry_out(outputs);
            }
            // Paced writes: let the clock run until nothing is due soon.
            while let Some(at) = self.core.next_wakeup() {
                if at.0 > self.now + 1_000 {
                    break;
                }
                self.now = self.now.max(at.0);
                let outputs = self.core.handle(Ts(self.now), Input::Tick).unwrap();
                self.carry_out(outputs);
                while let Some(input) = self.inputs.pop_front() {
                    let outputs = self.core.handle(Ts(self.now), input).unwrap();
                    self.carry_out(outputs);
                }
            }
        }

        fn carry_out(&mut self, outputs: Vec<Output>) {
            for output in outputs {
                match output {
                    Output::Persist(ops) => {
                        if self.store.apply(&ops).is_err() {
                            self.restart();
                            return;
                        }
                        for op in &ops {
                            if let StoreOp::PutMessage(m) = op {
                                *self
                                    .stored
                                    .entry((m.peer.as_str().into(), m.id.as_str().into()))
                                    .or_default() += 1;
                            }
                        }
                    }
                    Output::Event(event) => self.events.push(event),
                    Output::Send(frame) => {
                        let value: Value = serde_json::from_str(&frame).unwrap();
                        if value["k"] == "sync" {
                            let since = value["since"].as_i64().unwrap();
                            let limit = usize::try_from(value["limit"].as_u64().unwrap()).unwrap();
                            let page = self.server.sync_page(since, limit);
                            self.inputs.push_back(Input::Frame(page));
                        }
                        if value["k"] == "frame" && value["d"]["t"] == "ack" {
                            let peer = value["to"].as_str().unwrap().to_owned();
                            let mid = value["d"]["id"].as_str().unwrap().to_owned();
                            // A receipt only ever names a message already on disk.
                            assert!(
                                self.store.message(&peer, &mid).is_some(),
                                "ack for {mid} before it was stored"
                            );
                            // `markDelivered`: a message the server has a record of.
                            let record = self.server.history.get(&peer).and_then(|records| {
                                records.iter().find(|r| r.id == mid).map(|r| r.ts)
                            });
                            if let Some(ts) = record {
                                let held = self.server.delivered.entry(peer.clone()).or_default();
                                *held = (*held).max(ts);
                            }
                            self.acks.push((peer, mid));
                        }
                        self.wire.push(value);
                    }
                    Output::Fetch(request) => {
                        self.fetched += 1;
                        if self.auto {
                            let body = self.server.history(&request);
                            self.inputs.push_back(Input::History { request, body });
                        } else {
                            self.fetches.push(request);
                        }
                    }
                    Output::Post(request) => panic!("encryption is off: {request:?}"),
                }
            }
        }

        /// Answers the oldest unanswered fetch with the server's page now.
        fn answer(&mut self) -> HistoryRequest {
            let request = self.fetches.remove(0);
            let body = self.server.history(&request);
            self.input(Input::History {
                request: request.clone(),
                body,
            });
            request
        }

        /// Alice's rows for `peer`, in the model's shape.
        fn held(&self, peer: &str) -> Vec<Row> {
            self.store
                .conversation(peer)
                .into_iter()
                .map(|m| {
                    let mut reactions: Vec<(String, Vec<String>)> = m
                        .reactions
                        .iter()
                        .map(|r| {
                            let by = r.by.iter().map(|l| l.as_str().to_owned()).collect();
                            (r.emoji.clone(), by)
                        })
                        .collect();
                    reactions.sort();
                    (
                        m.id.as_str().to_owned(),
                        m.text.clone(),
                        m.edited_at.map(|t| t.0),
                        reactions,
                    )
                })
                .collect()
        }

        fn assert_mirrors(&self, peer: &str) {
            assert_eq!(self.held(peer), self.server.visible(peer), "{peer}");
        }

        /// No row was ever inserted twice: a second insert would have been a
        /// duplicate on any store keyed less strictly than this one.
        fn assert_no_duplicates(&self) {
            let twice: Vec<_> = self.stored.iter().filter(|(_, c)| **c > 1).collect();
            assert!(twice.is_empty(), "{twice:?}");
        }
    }

    // ------------------------------------------------------------ cases

    #[test]
    fn a_gap_deeper_than_one_history_page_is_closed_once() {
        let mut server = Server::new(2000);
        for n in 0..5 {
            server.message("bob", "bob", &format!("old-{n}"), false);
        }
        let mut h = Harness::new(server);
        h.connect();
        assert_eq!(h.store.conversation("bob").len(), 5);
        h.disconnect();

        h.server.burst("bob", "gap", 450);
        h.server.message("bob", ME, "from-web-1", false);
        h.server.message("bob", ME, "from-web-2", true);
        let fetched = h.fetched;
        h.connect();

        h.assert_mirrors("bob");
        assert_eq!(h.store.conversation("bob").len(), 457);
        assert!(h.store.snapshot.backfill.is_empty(), "no debt left");
        assert_eq!(h.core.cursor().0, h.server.seq);
        assert_eq!(h.store.snapshot.cursor.0, h.server.seq);
        // 452 owed, 200 per page: three pages, no more.
        assert_eq!(h.fetched - fetched, 3);
        // Every new row stored exactly once.
        h.assert_no_duplicates();
        // One receipt, for the newest message from bob, after it was stored.
        assert_eq!(h.acks.last().unwrap(), &("bob".into(), "gap-0449".into()));
        let newest = h.server.find("bob", "gap-0449").ts;
        assert_eq!(h.server.delivered["bob"], newest);
        assert!(h.store.snapshot.acks.is_empty());
    }

    #[test]
    fn old_messages_changed_while_offline_change_here_without_a_fetch() {
        let mut server = Server::new(2000);
        for n in 1..=4 {
            server.message("bob", "bob", &format!("m{n}"), false);
        }
        let mut h = Harness::new(server);
        h.connect();
        h.disconnect();
        let fetched = h.fetched;

        h.server.edit("bob", "m1", "edited once");
        h.server.edit("bob", "m1", "edited twice");
        h.server.delete("bob", "m2");
        h.server.react("bob", "m3", "👍", "bob", true);
        h.server.react("bob", "m4", "❤", ME, true);
        h.server.react("bob", "m4", "❤", ME, false);
        h.server.react("bob", "m4", "🔥", ME, true);
        let m4 = h.server.find("bob", "m4").ts;
        h.server.read("bob", ME, m4);
        h.connect();

        h.assert_mirrors("bob");
        assert!(h.store.message("bob", "m2").is_none());
        assert_eq!(h.fetched, fetched, "everything changed was already held");
        assert_eq!(h.store.snapshot.own_reads[0].read_ts.0, m4);
        assert!(h.events.iter().any(|e| matches!(
            e, Event::MessagesRemoved { ids, .. } if ids == &vec![id("m2")]
        )));
    }

    #[test]
    fn a_restart_in_the_middle_of_a_backfill_continues_from_disk() {
        let mut server = Server::new(2000);
        server.message("bob", "bob", "first", false);
        let mut h = Harness::new(server);
        h.connect();
        h.disconnect();
        h.server.burst("bob", "gap", 450);

        h.auto = false;
        h.connect();
        // The feed page moved the cursor and recorded the debt in one write.
        assert_eq!(h.store.snapshot.cursor.0, h.server.seq);
        assert_eq!(h.store.snapshot.backfill[0].owed.len(), 450);
        assert_eq!(h.fetches.len(), 1);
        h.answer();
        assert_eq!(h.store.conversation("bob").len(), 201);
        assert_eq!(h.store.snapshot.backfill[0].owed.len(), 250);
        assert_eq!(h.fetches.len(), 1, "the walk goes on below the first page");

        // Killed before the second page came back.
        h.restart();
        h.auto = true;
        h.connect();

        h.assert_mirrors("bob");
        assert!(h.store.snapshot.backfill.is_empty());
        h.assert_no_duplicates();
        assert_eq!(h.acks.last().unwrap().1, "gap-0449");
    }

    #[test]
    fn reset_rereads_every_conversation_even_across_a_restart() {
        let mut server = Server::new(50);
        for n in 1..=3 {
            server.message("bob", "bob", &format!("b{n}"), false);
        }
        server.message("carol", "carol", "c1", false);
        let mut h = Harness::new(server);
        h.connect();
        assert_eq!(h.store.conversation("bob").len(), 3);
        h.disconnect();

        // Far more than the feed keeps: its window no longer reaches alice.
        h.server.edit("bob", "b1", "edited in the hole");
        h.server.delete("bob", "b2");
        h.server.burst("bob", "hole", 300);
        h.server.react("carol", "c1", "👍", "carol", true);
        for n in 0..10 {
            h.server
                .message("carol", "carol", &format!("c-new-{n}"), false);
        }

        h.auto = false;
        h.connect();
        let reseeding: Vec<String> = h
            .store
            .snapshot
            .backfill
            .iter()
            .filter(|b| b.reseed.is_some())
            .map(|b| b.peer.as_str().to_owned())
            .collect();
        assert_eq!(reseeding, ["alice", "bob", "carol"]);
        // Answer until the bob reseed has read one page (its position on disk
        // is below the newest message), then crash.
        let bob_position = |h: &Harness| {
            h.store
                .snapshot
                .backfill
                .iter()
                .find(|b| b.peer.as_str() == "bob")
                .and_then(|b| b.reseed.clone())
        };
        while !matches!(bob_position(&h), Some(tailchat_core::WalkFrom::Below(_))) {
            h.answer();
        }
        h.restart();
        h.auto = true;
        h.connect();

        h.assert_mirrors("bob");
        h.assert_mirrors("carol");
        assert!(
            h.store.message("bob", "b2").is_none(),
            "deleted in the hole"
        );
        assert_eq!(
            h.store.message("bob", "b1").unwrap().text,
            "edited in the hole"
        );
        assert!(h.store.snapshot.backfill.is_empty());
        h.assert_no_duplicates();
    }

    #[test]
    fn a_history_page_older_than_the_feed_cannot_undo_it() {
        let mut server = Server::new(2000);
        server.message("bob", "bob", "m1", false);
        let mut h = Harness::new(server);
        h.connect();
        h.disconnect();
        for n in 1..=3 {
            h.server.message("bob", "bob", &format!("n{n}"), false);
        }

        h.auto = false;
        h.connect();
        let request = h.fetches.remove(0);
        let stale = h.server.history(&request);
        // While that page is on its way the feed says more.
        h.server.edit("bob", "m1", "newer");
        h.server.delete("bob", "n1");
        h.nudge();
        h.input(Input::History {
            request,
            body: stale,
        });

        assert_eq!(h.store.message("bob", "m1").unwrap().text, "newer");
        assert!(h.store.message("bob", "n1").is_none(), "not brought back");
        assert!(h.store.message("bob", "n3").is_some());
        assert!(h.store.snapshot.backfill.is_empty());
    }

    #[test]
    fn a_live_message_is_stored_before_its_receipt_is_written() {
        let mut h = Harness::new(Server::new(2000));
        h.connect();
        let outputs = h
            .core
            .handle(
                Ts(h.now),
                Input::Frame(
                    r#"{"k":"frame","from":"bob","d":{"t":"msg","id":"live-1","ts":5000,"text":"hi"}}"#
                        .into(),
                ),
            )
            .unwrap();
        let persist = outputs
            .iter()
            .position(|o| matches!(o, Output::Persist(ops) if ops.iter().any(|op| matches!(op, tailchat_core::StoreOp::PutMessage(_)))))
            .unwrap();
        let ack = outputs
            .iter()
            .position(|o| matches!(o, Output::Send(f) if f.contains(r#""t":"ack""#)))
            .unwrap();
        assert!(persist < ack);
        for output in outputs {
            if let Output::Persist(ops) = output {
                h.store.apply(&ops).unwrap();
            }
        }

        // The socket refused the receipt: it is owed again, on disk too.
        h.core
            .handle(
                Ts(h.now),
                Input::SendFailed {
                    peer: login("bob"),
                    id: id("live-1"),
                },
            )
            .map(|outputs| {
                for output in outputs {
                    if let Output::Persist(ops) = output {
                        h.store.apply(&ops).unwrap();
                    }
                }
            })
            .unwrap();
        assert_eq!(h.store.snapshot.acks[0].id, id("live-1"));
        h.restart();
        h.connect();
        assert!(
            h.wire
                .iter()
                .any(|f| f["d"]["t"] == "ack" && f["d"]["id"] == "live-1")
        );
        assert!(h.store.snapshot.acks.is_empty());
    }

    #[test]
    fn a_live_message_settles_what_the_feed_owed() {
        let mut server = Server::new(2000);
        server.message("bob", "bob", "m1", false);
        let mut h = Harness::new(server);
        h.auto = false;
        h.connect();
        assert_eq!(h.store.snapshot.backfill[0].owed, vec![id("m1")]);
        let ts = h.server.find("bob", "m1").ts;
        h.frame(&format!(
            r#"{{"k":"frame","from":"bob","d":{{"t":"msg","id":"m1","ts":{ts},"text":"text of m1"}}}}"#
        ));
        assert!(h.store.snapshot.backfill.is_empty());
        // The walk already in flight finds it held and stores nothing twice.
        h.answer();
        assert_eq!(h.stored[&("bob".into(), "m1".into())], 1);
    }

    #[test]
    fn history_failures_pause_shrink_or_give_up_by_cause() {
        let mut server = Server::new(2000);
        server.message("bob", "bob", "m1", false);
        server.message("carol", "carol", "c1", false);
        let mut h = Harness::new(server);
        h.auto = false;
        h.connect();

        // bob first: a network failure pauses, then the same walk again.
        let request = h.fetches.remove(0);
        assert_eq!(request.peer, login("bob"));
        h.input(Input::HistoryFailed {
            request: request.clone(),
            error: FetchError::Network,
        });
        assert!(h.fetches.is_empty(), "no retry storm");
        let wake = h.core.next_wakeup().unwrap();
        assert_eq!(wake.0, h.now + 5_000);
        h.now = wake.0;
        h.input(Input::Tick);
        let again = h.fetches.remove(0);
        assert_eq!(
            (again.peer.clone(), again.below.clone()),
            (request.peer, request.below)
        );
        assert_ne!(again.serial, request.serial);

        // Too large: the same position, half the page.
        h.input(Input::HistoryFailed {
            request: again.clone(),
            error: FetchError::TooLarge,
        });
        let smaller = h.fetches.remove(0);
        assert_eq!(smaller.limit, again.limit / 2);
        // A stale answer to the request that was replaced changes nothing.
        let body = h.server.history(&again);
        h.input(Input::History {
            request: again,
            body,
        });
        assert!(h.store.message("bob", "m1").is_none());

        // 403: bob is no longer a friend; the debt can never be paid.
        h.input(Input::HistoryFailed {
            request: smaller,
            error: FetchError::Status(403, None),
        });
        assert!(
            h.store
                .snapshot
                .backfill
                .iter()
                .all(|b| b.peer != login("bob"))
        );
        // ...and the walk moves on to carol.
        assert_eq!(h.fetches[0].peer, login("carol"));
        h.answer();
        assert!(h.store.message("carol", "c1").is_some());
        assert!(h.store.snapshot.backfill.is_empty());
    }

    #[test]
    fn the_feed_proves_a_send_whose_acceptance_was_lost() {
        let mut h = Harness::new(Server::new(2000));
        h.connect();
        h.input(Input::Action(tailchat_core::Action::SendText {
            id: id("m-mine"),
            peer: login("bob"),
            text: "hello".into(),
        }));
        assert!(h.wire.iter().any(|f| f["d"]["id"] == "m-mine"));
        // The server committed it; the `message-accepted` never arrived.
        h.server.records("bob").push(Record {
            id: "m-mine".into(),
            from: ME.into(),
            ts: 77_777,
            text: "hello".into(),
            edited_at: None,
            deleted_at: None,
            reactions: BTreeMap::new(),
        });
        h.server.event(
            json!({"kind":"message","peer":"bob","id":"m-mine","ts":77_777,"from":ME,"self":true}),
        );
        h.nudge();

        let sent = &h.store.snapshot.sent[0];
        assert_eq!(
            (sent.id.as_str(), sent.ts.0, sent.receipt),
            ("m-mine", 77_777, Receipt::Sent)
        );
        assert!(h.store.snapshot.pending.is_empty());
        assert!(h.store.snapshot.backfill.is_empty(), "ours is not owed");
        assert_eq!(h.fetched, 0);
    }

    #[test]
    fn a_page_answering_an_old_cursor_cannot_replay_an_old_edit() {
        let mut server = Server::new(2000);
        server.message("bob", "bob", "m1", false);
        let mut h = Harness::new(server);
        h.connect();
        let old_cursor = h.core.cursor().0;
        h.server.edit("bob", "m1", "one");
        h.server.edit("bob", "m1", "two");
        h.nudge();
        assert_eq!(h.store.message("bob", "m1").unwrap().text, "two");
        // A duplicate answer from before both edits.
        let replay = h.server.sync_page(old_cursor, 500);
        h.frame(&replay);
        assert_eq!(h.store.message("bob", "m1").unwrap().text, "two");
        let edited = h.store.message("bob", "m1").unwrap().edited_at.map(|t| t.0);
        assert_eq!(edited, h.server.find("bob", "m1").edited_at);
    }

    /// The answer to the last `LoadOlder` for `peer`: its oldest row and
    /// whether the conversation's start was reached.
    fn older_page(h: &Harness, peer: &str) -> Option<(Option<Below>, bool)> {
        h.events.iter().rev().find_map(|e| match e {
            Event::OlderPage {
                peer: p,
                oldest,
                complete,
            } if p.as_str() == peer => Some((oldest.clone(), *complete)),
            _ => None,
        })
    }

    fn load_older(h: &mut Harness, peer: &str) {
        let below = h.store.conversation(peer).first().map(|m| Below {
            id: m.id.clone(),
            ts: m.ts,
        });
        h.events.clear();
        h.input(Input::Action(Action::LoadOlder {
            peer: login(peer),
            below,
        }));
    }

    #[test]
    fn a_new_device_reads_what_the_feed_no_longer_has_on_demand() {
        // The server keeps ten feed events: carol's conversation and most of
        // bob's are older than that, as on an account with a busy month.
        let mut server = Server::new(10);
        for n in 0..5 {
            server.message("carol", "carol", &format!("c-{n}"), false);
        }
        server.burst("bob", "b", 450);
        let mut h = Harness::new(server);
        h.connect();
        assert!(h.store.conversation("carol").is_empty(), "no event names carol");
        assert_eq!(h.store.conversation("bob").len(), 200, "the page around the feed's ids");

        // Scrolling back in bob: two pages, the second one the beginning.
        load_older(&mut h, "bob");
        assert_eq!(older_page(&h, "bob").map(|p| p.1), Some(false));
        load_older(&mut h, "bob");
        let (oldest, complete) = older_page(&h, "bob").unwrap();
        assert!(complete);
        assert_eq!(oldest.unwrap().id, id("b-0000"));
        h.assert_mirrors("bob");

        // Opening carol: the newest page is the whole of it.
        load_older(&mut h, "carol");
        assert_eq!(older_page(&h, "carol").map(|p| p.1), Some(true));
        h.assert_mirrors("carol");
        h.assert_no_duplicates();
    }

    #[test]
    fn a_page_of_deleted_messages_still_moves_the_reader_down() {
        let mut server = Server::new(2000);
        for n in 0..3 {
            server.message("bob", "bob", &format!("old-{n}"), false);
        }
        for n in 0..3 {
            server.delete("bob", &format!("old-{n}"));
        }
        server.message("bob", "bob", "new", false);
        let mut h = Harness::new(server);
        h.connect();
        load_older(&mut h, "bob");
        let (oldest, complete) = older_page(&h, "bob").unwrap();
        assert!(complete);
        assert_eq!(oldest.unwrap().id, id("old-0"), "where a next page would start");
        h.assert_mirrors("bob");
    }

    #[test]
    fn a_page_asked_for_survives_failures_and_reconnects() {
        let mut server = Server::new(2000);
        server.message("bob", "bob", "m-1", false);
        let mut h = Harness::new(server);
        h.auto = false;
        h.connect();
        h.answer(); // the feed's own walk for m-1
        let ask = Input::Action(Action::LoadOlder {
            peer: login("bob"),
            below: None,
        });
        h.input(ask);
        let first = h.fetches.remove(0);

        // A network failure: the same page again after the pause, not lost.
        h.input(Input::HistoryFailed {
            request: first.clone(),
            error: FetchError::Network,
        });
        assert!(h.fetches.is_empty(), "no retry storm");
        let wake = h.core.next_wakeup().expect("a retry is due");
        h.now = wake.0;
        h.input(Input::Tick);
        let second = h.fetches.remove(0);
        assert_eq!(
            (second.peer.clone(), second.below.clone()),
            (first.peer.clone(), first.below.clone())
        );

        // The socket drops with the page in flight: asked on the next one.
        h.disconnect();
        h.connect();
        let third = h.fetches.remove(0);
        assert_eq!((third.peer.clone(), third.below.clone()), (first.peer, first.below));
        assert_ne!(third.serial, second.serial);

        // 403: bob is gone; the reader is told there is nothing more.
        h.events.clear();
        h.input(Input::HistoryFailed {
            request: third,
            error: FetchError::Status(403, None),
        });
        assert_eq!(older_page(&h, "bob"), Some((None, true)));
        assert!(h.fetches.is_empty());
    }

}
