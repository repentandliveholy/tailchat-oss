//! The account feed (`sync` / `sync-page` / `sync-nudge`), the history walks
//! that fill in what it names, and messages received live.
//!
//! The feed says *that* something happened, never what a message says: a
//! `message` event carries an id. Every id this device does not hold becomes
//! durable debt in the same `Persist` as the cursor that moved past it, so a
//! restart between the two can lose nothing. Once a feed pass is over, the
//! core walks `/api/history` back from the newest page until every id owed
//! when the walk began is found, or the beginning of the conversation proves
//! it is not there. After `reset` the feed has a hole nothing can name, so
//! every conversation is re-read whole, and the walk's position is durable.
//!
//! `seq` is the server's global counter (`accounts.js` `nextSeq`), shared by
//! every account: a jump in one account's feed is somebody else's event, not
//! a hole. Holes are only what `reset` says they are.

use std::collections::BTreeSet;

use crate::api::{
    Below, Event, FetchError, HistoryRequest, MessageKind, Output, OwedAck, OwnRead, PeerReceipts,
    Protection, StoreOp, WalkFrom,
};
use crate::error::CoreError;
use crate::frames::{
    self, HISTORY_PAGE, HistoryRecord, MessageBody, SYNC_PAGE_MAX, SyncEvent, SyncKind, SyncPage,
};
use crate::ids::{MessageId, Ts};
use crate::login::Login;
use crate::sync::{Walk, WalkKind};

use super::Core;

/// How many times one reseed page is asked again because a reaction in the
/// same conversation landed while it was in flight.
const REACT_REPEATS: u8 = 3;

/// Outputs gathered so that one page lands in one atomic `Persist`, followed
/// by its events and then anything else.
#[derive(Default)]
struct Batch {
    /// Every durable change, in order.
    ops: Vec<StoreOp>,
    /// UI news, after the changes are on disk.
    events: Vec<Event>,
    /// Socket writes and fetches, after both.
    rest: Vec<Output>,
}

impl Batch {
    /// One durable change.
    fn op(&mut self, op: StoreOp) {
        self.ops.push(op);
    }

    /// One piece of UI news.
    fn event(&mut self, event: Event) {
        self.events.push(event);
    }

    /// Folds another module's outputs in, keeping persist-before-send.
    fn absorb(&mut self, outputs: Vec<Output>) {
        for output in outputs {
            match output {
                Output::Persist(ops) => self.ops.extend(ops),
                Output::Event(event) => self.events.push(event),
                other => self.rest.push(other),
            }
        }
    }

    /// The outputs, in the order the driver must carry them out.
    fn finish(self) -> Vec<Output> {
        let mut out = Vec::with_capacity(1 + self.events.len() + self.rest.len());
        if !self.ops.is_empty() {
            out.push(Output::Persist(self.ops));
        }
        out.extend(self.events.into_iter().map(Output::Event));
        out.extend(self.rest);
        out
    }
}

/// Conversations whose debt changed while a batch was built.
type Touched = BTreeSet<Login>;

impl Core {
    /// `message-accepted`, or any other proof the server committed one of ours.
    pub(super) fn accept(&mut self, peer: &Login, id: &MessageId, ts: Ts) -> Vec<Output> {
        let out = self.outbox.accepted(peer, id, ts);
        if !out.is_empty() {
            self.sync.hold(peer.clone(), id.clone(), None);
        }
        out
    }

    /// A new authenticated socket: read the feed from the cursor, or, on a
    /// server without one, go straight to whatever history is still owed.
    pub(super) fn sync_connected(&mut self, now: Ts, feed: bool) -> Vec<Output> {
        self.sync.connected(feed);
        if feed {
            self.request_page()
        } else {
            self.drain(now)
        }
    }

    /// Asks for the next feed page, or remembers to once the one in flight
    /// arrives.
    pub(super) fn request_page(&mut self) -> Vec<Output> {
        if !self.ready || !self.sync.supported {
            return Vec::new();
        }
        if self.sync.page_in_flight {
            self.sync.again = true;
            return Vec::new();
        }
        match frames::sync_request(self.cursor, SYNC_PAGE_MAX) {
            Ok(frame) => {
                self.sync.page_in_flight = true;
                vec![Output::Send(frame)]
            }
            // A `sync` frame is a few dozen bytes: it cannot be too large.
            Err(_) => Vec::new(),
        }
    }

    /// Applies one feed page: its effects, the debt it creates and the new
    /// cursor land in one `Persist`.
    pub(super) fn on_sync_page(&mut self, page: SyncPage) -> Vec<Output> {
        self.sync.page_in_flight = false;
        let mut batch = Batch::default();
        let mut touched = Touched::new();
        if page.events.skipped > 0 {
            batch.event(Event::BadFrame {
                reason: format!(
                    "sync-page: {} unreadable events skipped",
                    page.events.skipped
                ),
            });
        }
        if page.reset {
            self.begin_reseed(&mut touched);
        }
        for event in page.events.items {
            // A page answering an older `since` must not replay an old edit
            // over a newer one.
            if event.seq > self.cursor {
                self.apply_event(event, &mut batch, &mut touched);
            }
        }
        for peer in &touched {
            batch.op(self.sync.debt_op(peer));
        }
        if page.cursor > self.cursor {
            self.cursor = page.cursor;
            batch.op(StoreOp::SetCursor(page.cursor));
        }
        let mut out = batch.finish();
        // A page requested after a nudge covers it: one request is enough.
        if page.more || std::mem::take(&mut self.sync.again) {
            out.extend(self.request_page());
        }
        out
    }

    /// One feed event.
    fn apply_event(&mut self, event: SyncEvent, batch: &mut Batch, touched: &mut Touched) {
        let peer = event.peer;
        match event.kind {
            SyncKind::Message => {
                let Some(id) = event.id else { return };
                if event.own && self.outbox.is_pending(&peer, &id) {
                    // The feed is proof of commit for a send whose
                    // `message-accepted` was lost.
                    if let Some(ts) = event.ts {
                        batch.absorb(self.accept(&peer, &id, ts));
                    }
                    return;
                }
                if self.sync.holds(&peer, &id) || self.sync.is_gone(&peer, &id) {
                    return;
                }
                // Ours from another device is owed too: it reaches this one
                // only live, on a subscription, or from history.
                if self.sync.owe(&peer, id) {
                    touched.insert(peer);
                }
            }
            SyncKind::Edit => {
                if let Some(id) = event.id {
                    let text = event.text.unwrap_or_default();
                    self.apply_edit(&peer, &id, text, event.ts, batch);
                }
            }
            SyncKind::Delete => {
                let mut ids = event.ids.items;
                if let Some(id) = event.id
                    && !ids.contains(&id)
                {
                    ids.push(id);
                }
                self.apply_removal(&peer, ids, batch, touched);
            }
            SyncKind::React => {
                if let (Some(id), Some(emoji), Some(by)) = (event.id, event.emoji, event.by) {
                    let add = event.add.unwrap_or(true);
                    self.apply_reaction(peer, id, emoji, by, add, batch);
                }
            }
            SyncKind::Read => {
                let Some(ts) = event.read_ts.or(event.ts) else {
                    return;
                };
                if event.own {
                    self.own_read(peer, ts, batch);
                } else {
                    batch.absorb(self.outbox.watermarks(PeerReceipts {
                        peer,
                        delivered_ts: Some(ts),
                        read_ts: Some(ts),
                    }));
                }
            }
            SyncKind::Other => {}
        }
    }

    /// A newer text for a held row; older or unknown edits change nothing,
    /// so a history page fetched before an edit cannot undo it.
    fn apply_edit(
        &mut self,
        peer: &Login,
        id: &MessageId,
        text: String,
        edited_at: Option<Ts>,
        batch: &mut Batch,
    ) {
        let Some(local) = self.sync.edited(peer, id) else {
            return;
        };
        if edited_at <= local {
            return;
        }
        self.sync.hold(peer.clone(), id.clone(), edited_at);
        self.outbox.edit_sent(peer, id, &text);
        batch.op(StoreOp::EditMessage {
            peer: peer.clone(),
            id: id.clone(),
            text,
            edited_at,
        });
        batch.event(Event::MessageStored {
            peer: peer.clone(),
            id: id.clone(),
        });
    }

    /// Deleted for everyone or hidden for this account: gone from this
    /// device, no longer owed, and never brought back by an older page.
    fn apply_removal(
        &mut self,
        peer: &Login,
        ids: Vec<MessageId>,
        batch: &mut Batch,
        touched: &mut Touched,
    ) {
        let mut held = Vec::new();
        for id in ids {
            if self.sync.settle(peer, &id) {
                touched.insert(peer.clone());
            }
            let was_held = self.sync.holds(peer, &id);
            self.sync.release(peer, id.clone());
            if was_held {
                held.push(id);
            }
        }
        if held.is_empty() {
            return;
        }
        self.outbox.remove_sent(peer, &held);
        batch.op(StoreOp::RemoveMessages {
            peer: peer.clone(),
            ids: held.clone(),
        });
        batch.event(Event::MessagesRemoved {
            peer: peer.clone(),
            ids: held,
        });
    }

    /// One person's emoji on a held row. An unheld row gets its reactions
    /// with its content, from history.
    fn apply_reaction(
        &mut self,
        peer: Login,
        id: MessageId,
        emoji: String,
        by: Login,
        add: bool,
        batch: &mut Batch,
    ) {
        if !self.sync.holds(&peer, &id) {
            return;
        }
        if let Some(walk) = &mut self.sync.walk
            && walk.request.peer == peer
        {
            walk.reacted = true;
        }
        batch.op(StoreOp::SetReaction {
            peer: peer.clone(),
            id: id.clone(),
            emoji,
            by,
            add,
        });
        batch.event(Event::MessageStored { peer, id });
    }

    /// This account's own read position, which only moves forward.
    fn own_read(&mut self, peer: Login, read_ts: Ts, batch: &mut Batch) {
        if self
            .sync
            .own_reads
            .get(&peer)
            .is_some_and(|&ts| ts >= read_ts)
        {
            return;
        }
        self.sync.own_reads.insert(peer.clone(), read_ts);
        batch.op(StoreOp::PutOwnRead(OwnRead {
            peer: peer.clone(),
            read_ts,
        }));
        batch.event(Event::OwnReadMoved { peer, read_ts });
    }

    /// `reset`: the feed lost events this device never saw. Every
    /// conversation it knows of is re-read from its newest message down.
    fn begin_reseed(&mut self, touched: &mut Touched) {
        let mut peers: Touched = self.roster.iter().cloned().collect();
        peers.insert(self.me.clone());
        peers.extend(self.sync.held_peers().cloned());
        for peer in peers {
            self.sync.debts.entry(peer.clone()).or_default().reseed = Some(WalkFrom::Newest);
            touched.insert(peer);
        }
        // A reseed already under way restarts from the top; its answer, if it
        // comes, belongs to a request nobody is waiting for any more.
        if self
            .sync
            .walk
            .as_ref()
            .is_some_and(|walk| walk.kind == WalkKind::Reseed)
        {
            self.sync.walk = None;
        }
    }

    /// A reader wants the page of `peer`'s conversation below `below`. A
    /// newer ask for the same conversation replaces one not fetched yet.
    pub(super) fn load_older(&mut self, now: Ts, peer: Login, below: Option<Below>) -> Vec<Output> {
        self.sync.older.insert(peer, below);
        self.drain(now)
    }

    /// Starts the next history walk, when one is owed and nothing stands in
    /// the way: a feed pass first, so a walk looks for everything the feed
    /// named; one walk at a time; never during a pause after a failure.
    pub(super) fn drain(&mut self, now: Ts) -> Vec<Output> {
        let sync = &mut self.sync;
        if !self.ready || sync.walk.is_some() || sync.page_in_flight || sync.refused {
            return Vec::new();
        }
        if sync.retry_at.is_some_and(|at| now < at) {
            return Vec::new();
        }
        sync.retry_at = None;
        let owed = sync
            .debts
            .iter()
            .find(|(_, debt)| !debt.owed.is_empty())
            .map(|(peer, debt)| (peer.clone(), debt.owed.clone()));
        let (peer, kind, below) = if let Some((peer, targets)) = owed {
            (peer, WalkKind::Owed(targets), None)
        } else if let Some((peer, from)) = sync
            .debts
            .iter()
            .find_map(|(peer, debt)| debt.reseed.clone().map(|from| (peer.clone(), from)))
        {
            let below = match from {
                WalkFrom::Newest => None,
                WalkFrom::Below(below) => Some(below),
            };
            (peer, WalkKind::Reseed, below)
        } else if let Some((peer, below)) = sync.older.pop_first() {
            // What the feed owes comes first: a reader's page is only asked
            // once the device is caught up.
            (peer, WalkKind::Older, below)
        } else {
            return Vec::new();
        };
        vec![self.walk_to(kind, peer, below, HISTORY_PAGE, 0)]
    }

    /// Issues one walk request and remembers it as the one in flight.
    fn walk_to(
        &mut self,
        kind: WalkKind,
        peer: Login,
        below: Option<Below>,
        limit: u16,
        repeats: u8,
    ) -> Output {
        let request = self.sync.request(peer, below, limit);
        self.sync.walk = Some(Walk {
            request: request.clone(),
            kind,
            reacted: false,
            repeats,
        });
        Output::Fetch(request)
    }

    /// One history page for the walk in flight. An answer to any other
    /// request is stale and ignored.
    pub(super) fn on_history(
        &mut self,
        now: Ts,
        request: &HistoryRequest,
        body: &str,
    ) -> Vec<Output> {
        let Some(walk) = self.sync.walk.take_if(|walk| &walk.request == request) else {
            return Vec::new();
        };
        let page = match frames::decode_history(body) {
            Ok(page) => page,
            Err(CoreError::FrameTooLarge { .. }) => {
                return self.history_failed(now, walk, FetchError::TooLarge);
            }
            Err(error) => {
                self.sync.failed(now);
                return vec![Output::Event(Event::BadFrame {
                    reason: format!("history: {error}"),
                })];
            }
        };
        if walk.reacted && walk.kind == WalkKind::Reseed && walk.repeats < REACT_REPEATS {
            let out = self.walk_to(
                walk.kind,
                walk.request.peer,
                walk.request.below,
                walk.request.limit,
                walk.repeats.saturating_add(1),
            );
            return vec![out];
        }
        self.sync.failures = 0;
        let peer = walk.request.peer.clone();
        let reseed = walk.kind == WalkKind::Reseed;
        // Reaction sets on a reseed page are the only news about reactions
        // the feed lost, unless one raced the request.
        let replace_reactions = reseed && !walk.reacted;
        let full = page.len() >= usize::from(walk.request.limit);
        let oldest = page.messages.items.first().map(|record| Below {
            id: record.id.clone(),
            ts: record.ts,
        });
        let mut batch = Batch::default();
        let mut touched = Touched::new();
        let mut newest_incoming: Option<(Ts, MessageId)> = None;
        for record in page.messages.items {
            if self.sync.settle(&peer, &record.id) {
                touched.insert(peer.clone());
            }
            // Server order is oldest first: on equal times the later wins.
            let candidate = (record.from == peer
                && peer != self.me
                && record.deleted_at.is_none()
                && newest_incoming
                    .as_ref()
                    .is_none_or(|(ts, _)| record.ts >= *ts))
            .then(|| (record.ts, record.id.clone()));
            let readable =
                self.apply_record(&peer, record, replace_reactions, &mut batch, &mut touched);
            if readable && candidate.is_some() {
                newest_incoming = candidate;
            }
        }
        if page.peer_read_ts.is_some() || page.peer_delivered_ts.is_some() {
            batch.absorb(self.outbox.watermarks(PeerReceipts {
                peer: peer.clone(),
                delivered_ts: page.peer_delivered_ts,
                read_ts: page.peer_read_ts,
            }));
        }
        // After the rows are in the batch: the receipt names a message this
        // device now holds, and the Persist lands before the socket write.
        if let Some((ts, id)) = newest_incoming
            && self.sync.holds(&peer, &id)
        {
            batch.absorb(self.outbox.owe_ack(OwedAck {
                peer: peer.clone(),
                id,
                ts,
            }));
        }

        // Where the walk goes next. A full page whose oldest row is the one
        // it started below would ask the same question again: stop and pause.
        let next_below = oldest
            .clone()
            .filter(|below| full && Some(below) != walk.request.below.as_ref());
        let mut next = None;
        let mut stuck = false;
        match walk.kind {
            WalkKind::Owed(targets) => {
                let still: BTreeSet<MessageId> = self
                    .sync
                    .debts
                    .get(&peer)
                    .map(|debt| targets.intersection(&debt.owed).cloned().collect())
                    .unwrap_or_default();
                if still.is_empty() {
                } else if !full {
                    // The beginning of the conversation: not there at all
                    // (hidden from this account, or before a contact purge).
                    for id in &still {
                        self.sync.settle(&peer, id);
                    }
                    touched.insert(peer.clone());
                } else if let Some(below) = next_below {
                    next = Some((WalkKind::Owed(still), below));
                } else {
                    stuck = true;
                }
            }
            WalkKind::Older => {
                batch.event(Event::OlderPage {
                    peer: peer.clone(),
                    oldest: oldest.clone(),
                    complete: !full,
                });
            }
            WalkKind::Reseed => {
                if let Some(debt) = self.sync.debts.get_mut(&peer) {
                    if !full {
                        debt.reseed = None;
                        if debt.is_empty() {
                            self.sync.debts.remove(&peer);
                        }
                    } else if let Some(below) = next_below {
                        debt.reseed = Some(WalkFrom::Below(below.clone()));
                        next = Some((WalkKind::Reseed, below));
                    } else {
                        stuck = true;
                    }
                    touched.insert(peer.clone());
                }
            }
        }
        for touched_peer in &touched {
            batch.op(self.sync.debt_op(touched_peer));
        }
        let mut out = batch.finish();
        if let Some((kind, below)) = next {
            out.push(self.walk_to(kind, peer, Some(below), walk.request.limit, 0));
        } else if stuck {
            self.sync.failed(now);
        }
        out.extend(self.on_tick(now));
        out
    }

    /// One record of a history page.
    fn apply_record(
        &mut self,
        peer: &Login,
        record: HistoryRecord,
        replace_reactions: bool,
        batch: &mut Batch,
        touched: &mut Touched,
    ) -> bool {
        if self.sync.is_gone(peer, &record.id) {
            return true;
        }
        if record.deleted_at.is_some() {
            self.apply_removal(peer, vec![record.id], batch, touched);
            return true;
        }
        if record.from == self.me && self.outbox.is_pending(peer, &record.id) {
            // The page proves the commit of a send whose acceptance was lost.
            batch.absorb(self.accept(peer, &record.id, record.ts));
        }
        if self.sync.holds(peer, &record.id) {
            // What this device holds is kept current by the feed; history
            // only wins with a newer edit, or after `reset`.
            let id = record.id;
            if record.e2ee.is_none() {
                self.apply_edit(peer, &id, record.text, record.edited_at, batch);
            }
            if replace_reactions {
                batch.op(StoreOp::PutReactions {
                    peer: peer.clone(),
                    id: id.clone(),
                    reactions: record.reactions,
                });
                batch.event(Event::MessageStored {
                    peer: peer.clone(),
                    id,
                });
            }
            return true;
        }
        let id = record.id.clone();
        self.sync.hold(peer.clone(), id.clone(), record.edited_at);
        let sealed = record.e2ee.clone().filter(|_| self.e2ee.enabled);
        let mut message = record.into_message(peer.clone());
        let mut media_lost = false;
        if let Some(raw) = sealed {
            let from = message.from.clone();
            let opened = self.open_envelope(peer, &from, &id, message.ts, message.kind, &raw);
            for op in opened.ops {
                batch.op(op);
            }
            let body = opened.body.unwrap_or_else(MessageBody::empty);
            message.text = body.text;
            message.author = body.name;
            message.image = body.image;
            message.voice = body.voice;
            message.reply_to = body.reply_to;
            message.forwarded_from = body.forwarded_from;
            message.buttons = body.buttons.items;
            message.edit_of = body.edit_of;
            message.protection = opened.protection;
            message.media_dropped |= opened.media_lost;
            media_lost = opened.media_lost;
        }
        batch.absorb(self.receive_carrier(&mut message));
        batch.op(StoreOp::PutMessage(Box::new(message)));
        batch.event(Event::MessageStored {
            peer: peer.clone(),
            id,
        });
        // Read whole, or the walk's receipt must not name it.
        !media_lost
    }

    /// A walk request that produced no page.
    pub(super) fn on_history_failed(
        &mut self,
        now: Ts,
        request: &HistoryRequest,
        error: FetchError,
    ) -> Vec<Output> {
        match self.sync.walk.take_if(|walk| &walk.request == request) {
            Some(walk) => self.history_failed(now, walk, error),
            None => Vec::new(),
        }
    }

    /// What a failed walk step costs, by cause.
    fn history_failed(&mut self, now: Ts, walk: Walk, error: FetchError) -> Vec<Output> {
        let peer = walk.request.peer.clone();
        if walk.kind == WalkKind::Older {
            match error {
                FetchError::TooLarge if walk.request.limit > 1 => {}
                FetchError::Status(400 | 403, _) => {
                    // Nothing more of this conversation will be shown.
                    let mut out = vec![Output::Event(Event::OlderPage {
                        peer,
                        oldest: None,
                        complete: true,
                    })];
                    out.extend(self.drain(now));
                    return out;
                }
                _ => {
                    // Still wanted: asked again after the pause, or on the
                    // next `ready` when the token was refused.
                    self.sync.older.entry(peer.clone()).or_insert(walk.request.below.clone());
                }
            }
        }
        match error {
            FetchError::TooLarge if walk.request.limit > 1 => {
                // Same position, half the page.
                vec![self.walk_to(
                    walk.kind,
                    peer,
                    walk.request.below,
                    walk.request.limit / 2,
                    walk.repeats,
                )]
            }
            FetchError::Status(401, _) => {
                self.sync.refused = true;
                vec![Output::Event(Event::ServerError {
                    code: "unknown_token".into(),
                    peer: None,
                    id: None,
                })]
            }
            FetchError::Status(status @ (400 | 403), _) => {
                // Not a conversation this account may read (a removed friend,
                // a login the server refuses): the debt can never be paid.
                self.sync.debts.remove(&peer);
                let code = if status == 403 {
                    "not_friends"
                } else {
                    "invalid_login"
                };
                let mut out = vec![
                    Output::Persist(vec![StoreOp::DropBackfill(peer.clone())]),
                    Output::Event(Event::ServerError {
                        code: code.into(),
                        peer: Some(peer),
                        id: None,
                    }),
                ];
                out.extend(self.drain(now));
                out
            }
            _ => {
                self.sync.failed(now);
                Vec::new()
            }
        }
    }

    /// A message relayed on the socket: stored, settled if owed, and — when
    /// the peer wrote it — acknowledged after it is on disk.
    pub(super) fn on_live_message(
        &mut self,
        now: Ts,
        peer: Login,
        own: bool,
        kind: MessageKind,
        body: MessageBody,
    ) -> Vec<Output> {
        let Some(id) = body.id.clone() else {
            return Vec::new();
        };
        if self.sync.holds(&peer, &id)
            || self.sync.is_gone(&peer, &id)
            || self.outbox.is_pending(&peer, &id)
        {
            return Vec::new();
        }
        let from = if own { self.me.clone() } else { peer.clone() };
        let ts = body.ts.unwrap_or(now);
        let incoming = !own && peer != self.me;
        let mut batch = Batch::default();
        self.sync.hold(peer.clone(), id.clone(), None);
        if self.sync.settle(&peer, &id) {
            batch.op(self.sync.debt_op(&peer));
        }
        let mut media_lost = false;
        let mut message = match body.e2ee.clone().filter(|_| self.e2ee.enabled) {
            Some(raw) => {
                let opened = self.open_envelope(&peer, &from, &id, ts, kind, &raw);
                for op in opened.ops {
                    batch.op(op);
                }
                media_lost = opened.media_lost;
                let mut message = opened.body.unwrap_or_else(MessageBody::empty).into_message(
                    peer.clone(),
                    id.clone(),
                    from,
                    ts,
                    kind,
                    opened.protection,
                );
                message.media_dropped = media_lost;
                message
            }
            None => body.into_message(peer.clone(), id.clone(), from, ts, kind, Protection::Plain),
        };
        batch.absorb(self.receive_carrier(&mut message));
        batch.op(StoreOp::PutMessage(Box::new(message)));
        batch.event(Event::MessageStored {
            peer: peer.clone(),
            id: id.clone(),
        });
        // An attachment this core could not read is not "delivered": the
        // sender keeps ✓ instead of a ✓✓ that would hide the loss. (A later
        // receipt in the conversation still moves the server's watermark.)
        if incoming && !media_lost {
            batch.absorb(self.outbox.owe_ack(OwedAck { peer, id, ts }));
        }
        batch.finish()
    }

    /// A stored row that may be an encrypted edit: applied to its target when
    /// it is one. The row itself is kept — it is a real message to the
    /// server, its unread count and its read watermark — and a client shows
    /// the target instead of it. Only an encrypted row can be an edit: an
    /// open `editOf` is somebody's invention and is dropped.
    pub(super) fn receive_carrier(&mut self, message: &mut crate::api::Message) -> Vec<Output> {
        if !matches!(message.protection, Protection::Encrypted)
            || message.edit_of == Some(message.id.clone())
        {
            message.edit_of = None;
        }
        let Some(target) = message.edit_of.clone() else {
            return Vec::new();
        };
        let (peer, from) = (message.peer.clone(), message.from.clone());
        self.carrier_edit(&peer, &target, &from, message.text.clone(), message.ts)
    }
}
