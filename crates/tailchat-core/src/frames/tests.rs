//! Codec tests.
//!
//! Two halves, both grounded in the real server:
//!
//! - decoding, against frames captured from a local `bin/cloud-server.js`
//!   (`tests/fixtures/frames.json`, tokens redacted, one synthetic error frame
//!   noted where it is used), plus hostile inputs built to break a parser;
//! - encoding, against the exact JSON the server's own `receive`/`relay`
//!   expects, character for character.

use std::collections::BTreeMap;

use crate::api::Outgoing;
use crate::error::CoreError;
use crate::ids::{MessageId, Seq, Ts};
use crate::login::Login;
use crate::platform::Token;
use crate::receipt::Receipt;

use super::inner::{Inner, Scope, TypingState};
use super::*;

/// Frames captured from an isolated local server; see the module docs.
const FIXTURES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/frames.json"
));

/// Every captured frame, keyed by the name it was captured under.
fn fixtures() -> BTreeMap<String, String> {
    serde_json::from_str(FIXTURES).expect("the fixture file is JSON")
}

/// One captured frame, by name.
fn frame(name: &str) -> String {
    fixtures()
        .remove(name)
        .unwrap_or_else(|| panic!("no fixture named {name}"))
}

/// One captured frame, decoded.
fn decoded(name: &str) -> ServerFrame {
    decode(&frame(name)).unwrap_or_else(|error| panic!("{name} did not decode: {error}"))
}

/// A login, for the encoder tests.
fn login(raw: &str) -> Login {
    Login::parse(raw).expect("test login")
}

/// A message id, for the encoder tests.
fn id(raw: &str) -> MessageId {
    MessageId::parse(raw).expect("test id")
}

// ---------------------------------------------------------------- decoding

#[test]
fn every_captured_frame_decodes() {
    for (name, raw) in fixtures() {
        match decode(&raw) {
            Ok(ServerFrame::Other) => panic!("{name} fell through to Other: {raw}"),
            Ok(_) => {}
            Err(error) => panic!("{name} did not decode: {error}"),
        }
    }
}

#[test]
fn ready_carries_the_roster_and_the_server_caps() {
    let ServerFrame::Ready(ready) = decoded("ready-full") else {
        panic!("not ready");
    };
    let me = ready.me.clone().expect("self");
    assert_eq!(me.login.as_str(), "alice");
    assert_eq!(me.name, "Alice");
    assert!(!me.extra_password_enabled);

    assert!(ready.has_cap("durable-ack"));
    assert!(ready.has_cap("sync-v1"));
    assert!(ready.has_cap("sync-nudge-v1"));
    assert!(ready.has_cap("call-v1"));
    assert!(!ready.has_cap("telepathy"));
    assert_eq!(ready.caps.skipped, 0);

    let bob = ready
        .users
        .items
        .iter()
        .find(|user| user.login.as_str() == "bob")
        .expect("bob is on the roster");
    assert!(bob.online);
    assert_eq!(bob.state, Some(PresenceState::Active));
    assert_eq!(bob.last_seen, Some(Ts(1793622387920)));
    assert_eq!(bob.pending, Some(0));
    assert_eq!(bob.alias.as_deref(), Some("Bobby"));
    assert_eq!(bob.shown_name(), "Bobby");
    assert!(!bob.callable);
    let last = bob.last.as_ref().expect("a roster line");
    assert_eq!(last.kind, PreviewKind::Human);
    assert!(!last.text.is_empty());

    let official = ready
        .users
        .items
        .iter()
        .find(|user| user.login.as_str() == "tailchat")
        .expect("the official account is on every roster");
    assert!(official.official);
    assert!(official.online);

    // The fixture's roster carries an unread reaction from bob.
    let with_reaction = ready
        .users
        .items
        .iter()
        .find(|user| !user.reaction_events.items.is_empty());
    if let Some(user) = with_reaction {
        let event = &user.reaction_events.items[0];
        assert_eq!(event.by.as_str(), "bob");
        assert!(!event.emoji.is_empty());
    }
}

#[test]
fn the_roster_without_caps_parses_the_same_way() {
    let ServerFrame::Users(roster) = decoded("users") else {
        panic!("not a roster");
    };
    assert!(
        roster
            .users
            .items
            .iter()
            .any(|user| user.login.as_str() == "alice")
    );
    assert_eq!(roster.users.skipped, 0);
}

#[test]
fn presence_and_subscribed_say_who_is_where() {
    let ServerFrame::Presence(presence) = decoded("presence") else {
        panic!("not presence");
    };
    assert_eq!(presence.peer.as_str(), "alice");
    assert!(presence.online);
    assert_eq!(presence.state, Some(PresenceState::Active));

    let ServerFrame::Subscribed(subscribed) = decoded("subscribed-alice") else {
        panic!("not subscribed");
    };
    assert_eq!(subscribed.peer.as_str(), "alice");
    assert!(subscribed.online);
    assert_eq!(subscribed.pending, Some(2));
}

#[test]
fn a_relayed_message_carries_everything_the_sender_wrote() {
    let ServerFrame::Frame(relayed) = decoded("frame-msg") else {
        panic!("not a frame");
    };
    assert_eq!(relayed.from.as_str(), "alice");
    assert!(!relayed.own);
    let Inner::Message(message) = relayed.d else {
        panic!("not a message");
    };
    assert_eq!(
        message.id.as_ref().map(MessageId::as_str),
        Some("m-fixture-0001")
    );
    assert_eq!(message.ts, Some(Ts(1793622386663)));
    assert_eq!(message.text, "hello bob");
    assert_eq!(message.name.as_deref(), Some("Alice"));
    assert!(message.image.is_none());
    assert!(message.reply_to.is_none());
    assert!(message.buttons.items.is_empty());
}

#[test]
fn pictures_voice_quotes_forwards_and_buttons_survive_the_wire() {
    let ServerFrame::Frame(relayed) = decoded("frame-msg-image") else {
        panic!("not a frame");
    };
    let Inner::Message(message) = relayed.d else {
        panic!("not a message");
    };
    let image = message.image.expect("the picture");
    assert!(image.data_url.starts_with("data:image/png;base64,"));
    assert_eq!((image.width, image.height), (Some(1), Some(1)));
    assert_eq!(message.text, "", "a picture with no caption");

    let ServerFrame::Frame(relayed) = decoded("frame-msg-voice") else {
        panic!("not a frame");
    };
    let Inner::Message(message) = relayed.d else {
        panic!("not a message");
    };
    let voice = message.voice.expect("the voice note");
    assert!(voice.data_url.starts_with("data:audio/ogg;base64,"));
    assert_eq!(voice.duration, Some(1.5));

    let ServerFrame::Frame(relayed) = decoded("frame-msg-forwarded") else {
        panic!("not a frame");
    };
    let Inner::Message(message) = relayed.d else {
        panic!("not a message");
    };
    let forwarded = message.forwarded_from.expect("the forward");
    assert_eq!(forwarded.login.as_ref().map(Login::as_str), Some("bob"));
    assert_eq!(forwarded.name.as_deref(), Some("Bob"));

    // The official account's welcome: inline buttons a client draws.
    let ServerFrame::Frame(relayed) = decoded("frame-msg-service-welcome") else {
        panic!("not a frame");
    };
    assert_eq!(relayed.from.as_str(), "tailchat");
    let Inner::Message(message) = relayed.d else {
        panic!("not a message");
    };
    assert_eq!(message.buttons.items.len(), 3);
    assert_eq!(message.buttons.items[0].label, "Помощь");
    assert_eq!(message.buttons.items[0].value, "/help");
    assert_eq!(message.buttons.skipped, 0);

    // A bot message with the sender's own fractional clock.
    let ServerFrame::Frame(relayed) = decoded("frame-msg-buttons-float-ts") else {
        panic!("not a frame");
    };
    let Inner::Message(message) = relayed.d else {
        panic!("not a message");
    };
    assert_eq!(message.ts, Some(Ts(1793622391280)));
    assert_eq!(message.buttons.items.len(), 2);
}

#[test]
fn a_message_from_our_own_other_device_is_marked_self() {
    let ServerFrame::Frame(relayed) = decoded("frame-self-msg") else {
        panic!("not a frame");
    };
    assert!(relayed.own);
    // The `from` of a self-synced frame is the peer of the conversation, not
    // the account itself (`selfSync`, hub.js).
    assert_eq!(relayed.from.as_str(), "bob");
    let Inner::Message(message) = relayed.d else {
        panic!("not a message");
    };
    let reply = message.reply_to.expect("a reply");
    assert_eq!(reply.id.as_str(), "m-fixture-0001");
    assert_eq!(reply.from.as_str(), "alice");
    assert_eq!(reply.text, "hello bob");
    assert!(reply.media.is_none());
}

#[test]
fn receipts_carry_their_watermarks() {
    let ServerFrame::Frame(relayed) = decoded("frame-ack") else {
        panic!("not a frame");
    };
    let Inner::Ack(ack) = relayed.d else {
        panic!("not an ack");
    };
    assert_eq!(ack.id.as_str(), "m-fixture-0001");
    assert_eq!(ack.delivered_ts, Some(Ts(1793622386663)));

    let ServerFrame::Frame(relayed) = decoded("frame-read") else {
        panic!("not a frame");
    };
    let Inner::Read(read) = relayed.d else {
        panic!("not a read");
    };
    assert_eq!(read.id.as_str(), "m-fixture-0003");
    assert_eq!(read.read_ts, Some(Ts(1793622389276)));
    assert_eq!(read.read_at, Some(Ts(1793622392385)));
    assert_eq!(read.via.as_deref(), Some("cli"));
}

#[test]
fn an_edit_a_delete_and_a_reaction_keep_their_meaning() {
    let ServerFrame::Frame(relayed) = decoded("frame-edit") else {
        panic!("not a frame");
    };
    let Inner::Edit(edit) = relayed.d else {
        panic!("not an edit");
    };
    assert_eq!(edit.id.as_str(), "m-fixture-0003");
    assert_eq!(edit.text, "a reply (edited)");
    // The server builds this frame from a record that does not carry the
    // field (`commitEdit`), so a real frame has no `editedAt`.
    assert_eq!(edit.edited_at, None);

    let ServerFrame::Frame(relayed) = decoded("frame-del") else {
        panic!("not a frame");
    };
    let Inner::Delete(delete) = relayed.d else {
        panic!("not a delete");
    };
    assert_eq!(delete.ids.items.len(), 1);
    assert_eq!(delete.ids.items[0].as_str(), "m-fixture-0002");
    assert_eq!(delete.scope(), Scope::All);
    assert!(delete.tombstone);

    let ServerFrame::Frame(relayed) = decoded("frame-react") else {
        panic!("not a frame");
    };
    let Inner::React(react) = relayed.d else {
        panic!("not a reaction");
    };
    assert_eq!(react.id.as_str(), "m-fixture-0001");
    assert_eq!(react.emoji, "👍");
    assert_eq!(react.by.as_str(), "alice");
    assert!(react.add);
}

#[test]
fn typing_says_whether_it_started_or_stopped() {
    let ServerFrame::Frame(relayed) = decoded("frame-typing") else {
        panic!("not a frame");
    };
    let Inner::Typing(typing) = relayed.d else {
        panic!("not typing");
    };
    assert_eq!(typing.state, TypingState::Start);
    assert_eq!(typing.name.as_deref(), Some("Alice"));
}

#[test]
fn frames_this_core_does_not_type_are_unknown_not_errors() {
    for (name, expected) in [
        ("frame-hello", "hello"),
        ("frame-focus", "focus"),
        ("frame-call-offer", "call-offer"),
        ("frame-call-end", "call-end"),
    ] {
        let ServerFrame::Frame(relayed) = decoded(name) else {
            panic!("{name}: not a frame");
        };
        assert_eq!(
            relayed.d,
            Inner::Unknown,
            "{name} should be unknown ({expected})"
        );
    }
}

#[test]
fn an_accepted_message_carries_its_seq() {
    let ServerFrame::MessageAccepted(accepted) = decoded("message-accepted") else {
        panic!("not accepted");
    };
    assert_eq!(accepted.peer.as_str(), "bob");
    assert_eq!(accepted.id.as_str(), "m-fixture-0001");
    assert_eq!(accepted.ts, Ts(1793622386663));
    assert_eq!(accepted.seq, Some(Seq(3)));
}

#[test]
fn read_and_op_acceptances_name_what_they_confirm() {
    let ServerFrame::ReadAccepted(accepted) = decoded("read-accepted") else {
        panic!("not read-accepted");
    };
    assert_eq!(accepted.peer.as_str(), "alice");
    assert_eq!(
        accepted.id.as_ref().map(MessageId::as_str),
        Some("m-fixture-0003")
    );
    assert_eq!(accepted.read_ts, Ts(1793622389276));
    assert_eq!(accepted.read_at, Some(Ts(1793622392385)));
    assert_eq!(accepted.via.as_deref(), Some("cli"));

    let ServerFrame::OpAccepted(accepted) = decoded("op-accepted") else {
        panic!("not op-accepted");
    };
    assert_eq!(accepted.op_kind, OpKind::Edit);
    assert_eq!(
        accepted.id.as_ref().map(MessageId::as_str),
        Some("m-fixture-0003")
    );
    assert_eq!(accepted.op_id.as_deref(), Some("op-edit-1"));
}

#[test]
fn a_sync_page_reads_every_kind_of_event() {
    let ServerFrame::SyncPage(page) = decoded("sync-page-full") else {
        panic!("not a sync page");
    };
    assert_eq!(page.cursor, Seq(20));
    assert!(!page.more);
    assert!(!page.reset);
    assert!(page.is_clean(), "a captured page holds no broken events");
    assert_eq!(page.events.items.len(), 18);

    let kinds: Vec<SyncKind> = page.events.items.iter().map(|event| event.kind).collect();
    for expected in [
        SyncKind::Message,
        SyncKind::Edit,
        SyncKind::Delete,
        SyncKind::React,
        SyncKind::Read,
    ] {
        assert!(
            kinds.contains(&expected),
            "{expected:?} missing from {kinds:?}"
        );
    }

    let appended = page
        .events
        .items
        .iter()
        .find(|event| event.id.as_ref().map(MessageId::as_str) == Some("m-fixture-0007"))
        .expect("the message with the float time");
    // The sender's own clock was kept as `1793622391280.5`: floored, not
    // rounded, and not refused.
    assert_eq!(appended.ts, Some(Ts(1793622391280)));
    assert!(appended.own);

    let own_reaction = page
        .events
        .items
        .iter()
        .find(|event| event.kind == SyncKind::React && event.emoji.as_deref() == Some("👍"))
        .expect("our own reaction");
    assert_eq!(own_reaction.by.as_ref().map(Login::as_str), Some("alice"));
    assert_eq!(own_reaction.add, Some(true));

    let read = page
        .events
        .items
        .iter()
        .find(|event| event.kind == SyncKind::Read && event.via.as_deref() == Some("android/104"))
        .expect("the phone's read");
    assert_eq!(read.read_ts, Some(Ts(1793622391280)));
    assert_eq!(read.read_at, Some(Ts(1793622392885)));

    let delete = page
        .events
        .items
        .iter()
        .find(|event| event.kind == SyncKind::Delete && event.scope == Some(Scope::SelfOnly))
        .expect("a hide");
    assert_eq!(delete.ids.items.len(), 1);
}

#[test]
fn a_sync_page_says_when_it_more_or_needs_reseeding() {
    let ServerFrame::SyncPage(page) = decoded("sync-page-more") else {
        panic!("not a sync page");
    };
    assert!(page.more);

    let ServerFrame::SyncPage(page) = decoded("sync-page-reset") else {
        panic!("not a sync page");
    };
    assert!(page.reset, "the cursor was older than the retained log");
    assert!(page.more);
    assert_eq!(page.cursor, Seq(125));

    let ServerFrame::SyncPage(page) = decoded("sync-page-empty") else {
        panic!("not a sync page");
    };
    assert!(page.events.items.is_empty());
    assert!(!page.more);
    assert!(!page.reset);
}

#[test]
fn account_local_envelopes_reach_the_right_owner() {
    let ServerFrame::SyncNudge = decoded("sync-nudge") else {
        panic!("not a nudge");
    };

    let ServerFrame::ReadSync(sync) = decoded("read-sync") else {
        panic!("not read-sync");
    };
    assert_eq!(sync.peer.as_str(), "alice");
    assert_eq!(sync.read_ts, Ts(1793622389276));

    let ServerFrame::ReactSync(sync) = decoded("react-sync") else {
        panic!("not react-sync");
    };
    assert_eq!(sync.id.as_str(), "m-fixture-0001");
    assert_eq!(sync.by.as_str(), "alice");
    assert!(sync.add);

    let ServerFrame::Unread(unread) = decoded("unread") else {
        panic!("not unread");
    };
    assert_eq!(unread.from.as_str(), "alice");
    assert_eq!(unread.text, "hello bob");
    assert_eq!(unread.count, Some(1));

    let ServerFrame::ConversationUpdate(update) = decoded("conversation-update-peer") else {
        panic!("not conversation-update");
    };
    assert!(!update.own);
    let last = update.last.expect("a roster line");
    assert_eq!(last.author.as_deref(), Some("Alice Fixture"));

    let ServerFrame::MessageEvent(event) = decoded("message-event-edit") else {
        panic!("not message-event");
    };
    assert!(event.own);
    assert!(matches!(event.d, Inner::Edit(_)));
}

#[test]
fn throttle_errors_profile_and_reminders_are_typed() {
    let ServerFrame::Throttle(throttle) = decoded("throttle") else {
        panic!("not throttle");
    };
    assert_eq!(throttle.window_ms, 1000);
    assert_eq!(throttle.frames, 61);
    assert_eq!(throttle.limit, 60);

    let ServerFrame::Error(error) = decoded("error-message_id_conflict") else {
        panic!("not an error");
    };
    assert_eq!(error.code, "message_id_conflict");
    assert_eq!(error.peer.as_ref().map(Login::as_str), Some("bob"));
    assert_eq!(
        error.id.as_ref().map(MessageId::as_str),
        Some("m-fixture-0001")
    );

    // The one fixture that could not be captured: `store_failed` needs the
    // store itself to fail, so this frame is written from `hub.js`'s own
    // `commitAndDeliver` and checked like the rest.
    let ServerFrame::Error(error) = decoded("error-store-failed") else {
        panic!("not an error");
    };
    assert_eq!(error.code, "store_failed");
    assert_eq!(error.peer.as_ref().map(Login::as_str), Some("bob"));

    let ServerFrame::Profile(profile) = decoded("profile") else {
        panic!("not a profile");
    };
    assert_eq!(profile.user.login.as_str(), "alice");
    assert_eq!(profile.user.name, "Alice Fixture");

    let ServerFrame::ReplyReminderSet { reminder } = decoded("reply-reminder-set") else {
        panic!("not a reminder");
    };
    assert_eq!(reminder.peer.as_str(), "alice");
    assert_eq!(reminder.message_id.as_str(), "m-fixture-0001");
    assert_eq!(reminder.fired_at, None);

    let ServerFrame::ReplyReminderFired { reminder } = decoded("reply-reminder-fired") else {
        panic!("not a fired reminder");
    };
    assert_eq!(reminder.fired_at, Some(Ts(1793622402901)));

    let ServerFrame::ReplyReminderAcked { id: acked } = decoded("reply-reminder-acked") else {
        panic!("not an ack");
    };
    assert_eq!(acked, "1c796acd-9946-47bb-a0c0-7b49404f45f3");

    let ServerFrame::MarkUnreadAccepted { peer } = decoded("mark-unread-accepted") else {
        panic!("not mark-unread-accepted");
    };
    assert_eq!(peer.as_str(), "alice");
}

// ---------------------------------------------------------------- tolerance

#[test]
fn a_fractional_or_negative_time_is_floored_not_refused() {
    let accepted =
        r#"{"k":"message-accepted","peer":"bob","id":"m-1","ts":1793622386663.9,"seq":9}"#;
    let ServerFrame::MessageAccepted(accepted) = decode(accepted).expect("decodes") else {
        panic!("not accepted");
    };
    assert_eq!(accepted.ts, Ts(1793622386663));

    let negative = r#"{"k":"message-accepted","peer":"bob","id":"m-1","ts":-1.5,"seq":0}"#;
    let ServerFrame::MessageAccepted(accepted) = decode(negative).expect("decodes") else {
        panic!("not accepted");
    };
    assert_eq!(accepted.ts, Ts(-2));

    // 2^53 + 1 cannot be a float exactly, but came from a JS number: keep it.
    let big = r#"{"k":"message-accepted","peer":"bob","id":"m-1","ts":9007199254740992,"seq":1}"#;
    assert!(decode(big).is_ok());
}

#[test]
fn an_unreadable_optional_field_reads_as_absent() {
    // `seq` is optional: a record written before the feed existed has none, so
    // a value the codec cannot read is "no seq", not a lost message.
    let raw = r#"{"k":"message-accepted","peer":"bob","id":"m-1","ts":1,"seq":"3"}"#;
    let ServerFrame::MessageAccepted(accepted) = decode(raw).expect("decodes") else {
        panic!("not accepted");
    };
    assert_eq!(accepted.seq, None);
    assert_eq!(accepted.ts, Ts(1));
}

#[test]
fn one_broken_event_costs_that_event_and_nothing_else() {
    let raw = r#"{"k":"sync-page","events":[
        {"seq":1,"kind":"message","peer":"bob","id":"m-1","ts":10,"from":"alice"},
        {"seq":"two","kind":"message","peer":"bob","id":"m-2"},
        {"seq":3,"kind":"read","peer":"bob","readTs":12},
        {"seq":4,"kind":"message","peer":"not a login","id":"m-3"}
    ],"cursor":4,"more":false,"reset":false}"#;
    let ServerFrame::SyncPage(page) = decode(raw).expect("the page decodes") else {
        panic!("not a sync page");
    };
    assert_eq!(page.events.items.len(), 2);
    assert_eq!(page.events.skipped, 2);
    assert!(!page.is_clean());
    assert_eq!(page.cursor, Seq(4));
}

#[test]
fn an_unknown_event_kind_is_kept_as_other() {
    let raw = r#"{"k":"sync-page","events":[{"seq":7,"kind":"pin","peer":"bob"}],"cursor":7}"#;
    let ServerFrame::SyncPage(page) = decode(raw).expect("decodes") else {
        panic!("not a sync page");
    };
    assert_eq!(page.events.skipped, 0);
    assert_eq!(page.events.items.len(), 1);
    assert_eq!(page.events.items[0].kind, SyncKind::Other);
}

#[test]
fn unknown_and_extra_fields_are_ignored() {
    let raw =
        r#"{"k":"presence","peer":"alice","online":true,"state":"active","future":["x"],"n":1}"#;
    assert!(matches!(decode(raw), Ok(ServerFrame::Presence(_))));

    let raw = r#"{"k":"frame","from":"alice","d":{"t":"msg","id":"m-1","ts":1,"text":"x","someday":"y"},"extra":{"a":1}}"#;
    let ServerFrame::Frame(relayed) = decode(raw).expect("decodes") else {
        panic!("not a frame");
    };
    assert!(matches!(relayed.d, Inner::Message(_)));
}

#[test]
fn an_unknown_inner_type_or_envelope_is_not_an_error() {
    assert!(matches!(
        decode(r#"{"k":"frame","from":"alice","d":{"t":"rtc-offer","sdp":"v=0"}}"#),
        Ok(ServerFrame::Frame(_))
    ));
    assert!(matches!(
        decode(r#"{"k":"brand-new","payload":{}}"#),
        Ok(ServerFrame::Other)
    ));
}

#[test]
fn a_message_with_a_wrong_typed_attachment_still_arrives() {
    let raw = r#"{"k":"frame","from":"alice","d":{"t":"msg","id":"m-1","ts":1,"text":42,
        "image":{"dataUrl":"data:image/png;base64,AA","width":"wide"}}}"#;
    let ServerFrame::Frame(relayed) = decode(raw).expect("decodes") else {
        panic!("not a frame");
    };
    let Inner::Message(message) = relayed.d else {
        panic!("not a message");
    };
    assert_eq!(message.text, "", "a non-string text reads as empty");
    let image = message.image.expect("the picture survives");
    assert_eq!(image.width, None);
}

// ---------------------------------------------------------------- hostile

#[test]
fn garbage_is_a_bad_frame_not_a_panic() {
    for raw in [
        "",
        " ",
        "{",
        "}",
        "not json",
        "[]",
        "null",
        "5",
        r#"{"no":"k"}"#,
        r#"{"k":null}"#,
        r#"{"k":0}"#,
        r#"{"k":["ready"]}"#,
        r#"{"k":"presence"}"#,
        r#"{"k":"presence","peer":5}"#,
        r#"{"k":"message-accepted","peer":"bob","id":"m-1","ts":"soon"}"#,
        r#"{"k":"frame","from":"alice","d":"not an object"}"#,
        r#"{"k":"frame","from":"alice","d":{"t":"ack"}}"#,
        r#"{"k":"sync-page","events":[],"cursor":"zero"}"#,
    ] {
        assert!(
            matches!(decode(raw), Err(CoreError::BadFrame(_))),
            "{raw:?}"
        );
    }
}

#[test]
fn a_number_too_big_to_hold_is_a_bad_frame() {
    for raw in [
        r#"{"k":"message-accepted","peer":"bob","id":"m-1","ts":1e999}"#,
        r#"{"k":"message-accepted","peer":"bob","id":"m-1","ts":1e30}"#,
        r#"{"k":"message-accepted","peer":"bob","id":"m-1","ts":-1e30}"#,
        r#"{"k":"message-accepted","peer":"bob","id":"m-1","ts":184467440737095516160}"#,
    ] {
        assert!(matches!(decode(raw), Err(CoreError::BadFrame(_))), "{raw}");
    }
}

#[test]
fn the_size_limit_is_checked_before_parsing() {
    let huge = " ".repeat(MAX_INBOUND + 1);
    assert!(matches!(
        decode(&huge),
        Err(CoreError::FrameTooLarge { max, .. }) if max == MAX_INBOUND
    ));
    // One byte under the limit is parsed (and fails as JSON, not as size).
    let almost = "{".repeat(MAX_INBOUND);
    assert!(matches!(decode(&almost), Err(CoreError::BadFrame(_))));
}

// ---------------------------------------------------------------- encoding

#[test]
fn auth_is_exactly_what_the_server_expects() {
    let token = Token::parse(&"a".repeat(64)).expect("token");
    assert_eq!(
        auth(&token).expect("auth frame"),
        format!(
            r#"{{"k":"auth","token":"{}","caps":["durable-ack","addressed-send","sync-nudge-v1"]}}"#,
            "a".repeat(64)
        )
    );
}

#[test]
fn auth_extras_are_valid_unique_and_ordered() {
    let token = Token::parse(&"a".repeat(64)).unwrap();
    let extra = [
        "read-ack-v1".to_owned(),
        "durable-ack".to_owned(),
        "read-ack-v1".to_owned(),
        String::new(),
        "UPPER".to_owned(),
        "space here".to_owned(),
        "é".to_owned(),
        "x".repeat(64),
        "x".repeat(65),
        "another-2".to_owned(),
    ];
    let frame: serde_json::Value =
        serde_json::from_str(&auth_with(&token, &extra).unwrap()).unwrap();
    assert_eq!(
        frame["caps"],
        serde_json::json!([
            "durable-ack",
            "addressed-send",
            "sync-nudge-v1",
            "read-ack-v1",
            "x".repeat(64),
            "another-2"
        ])
    );
    assert_eq!(auth_with(&token, &[]).unwrap(), auth(&token).unwrap());
}

#[test]
fn auth_says_web_features_only_for_the_browser() {
    let token = Token::parse(&"a".repeat(64)).unwrap();
    let plain: serde_json::Value =
        serde_json::from_str(&auth_for(&token, &[], false).unwrap()).unwrap();
    assert!(plain.get("webFeatures").is_none());
    assert_eq!(auth_for(&token, &[], false).unwrap(), auth(&token).unwrap());
    let web: serde_json::Value =
        serde_json::from_str(&auth_for(&token, &[], true).unwrap()).unwrap();
    assert_eq!(web["webFeatures"], serde_json::json!(true));
    assert_eq!(web["k"], "auth");
}

#[test]
fn send_keys_only_identify_addressed_messages_and_receipts() {
    for kind in ["msg", "ai", "ack", "read"] {
        let frame = format!(r#"{{"k":"frame","to":"bob","d":{{"t":"{kind}","id":"m-1"}}}}"#);
        assert_eq!(send_key(&frame), Some((login("bob"), id("m-1"))));
    }
    for frame in [
        r#"{"k":"auth","to":"bob","d":{"t":"msg","id":"m-1"}}"#,
        r#"{"k":"sync"}"#,
        r#"{"k":"subscribe","peer":"bob"}"#,
        r#"{"k":"frame","to":"bob","d":{"t":"typing","id":"m-1"}}"#,
        r#"{"k":"frame","to":"bob","d":{"t":"msg"}}"#,
        r#"{"k":"frame","to":"bad login","d":{"t":"msg","id":"m-1"}}"#,
        r#"{"k":"frame","to":"bob","d":{"t":"msg","id":""}}"#,
        r#"{"k":"frame","to":"bob","d":{"t":"msg","id":7}}"#,
        "not json",
    ] {
        assert_eq!(send_key(frame), None, "{frame}");
    }
}

#[test]
fn subscribe_and_unsubscribe_are_exact() {
    assert_eq!(
        subscribe(&login("bob")).expect("subscribe"),
        r#"{"k":"subscribe","peer":"bob"}"#
    );
    assert_eq!(
        unsubscribe().expect("unsubscribe"),
        r#"{"k":"subscribe","peer":""}"#
    );
}

#[test]
fn msg_is_exactly_what_the_server_expects() {
    let message = Outgoing {
        extra: Default::default(),
        id: id("m-1"),
        peer: login("bob"),
        ts: Ts(5),
        text: "hi \"bob\"".into(),
        image: None,
        receipt: Receipt::Queued,
    };
    assert_eq!(
        msg(&message).expect("msg frame"),
        r#"{"k":"frame","to":"bob","d":{"t":"msg","id":"m-1","ts":5,"text":"hi \"bob\""}}"#
    );
}

#[test]
fn an_open_msg_carries_its_quote_label_and_voice_as_the_server_keeps_them() {
    use crate::api::{Extra, OutVoice};
    use crate::frames::inner::{Forwarded, MediaKind, Reply};
    let long = "я".repeat(250);
    let message = Outgoing {
        extra: Box::new(Extra {
            reply_to: Some(Reply {
                id: id("m-0"),
                from: login("alice"),
                text: long,
                media: Some(MediaKind::Image),
            }),
            forwarded_from: Some(Forwarded {
                login: Some(login("carol")),
                name: None,
            }),
            voice: Some(OutVoice {
                data_url: "data:audio/mp4;base64,AAAA".into(),
                duration_ms: 1500,
                waveform: vec![1, 2],
            }),
            edit_of: None,
        }),
        id: id("m-1"),
        peer: login("bob"),
        ts: Ts(5),
        text: "x".into(),
        image: None,
        receipt: Receipt::Queued,
    };
    let frame: serde_json::Value =
        serde_json::from_str(&msg(&message).expect("msg")).expect("json");
    let d = &frame["d"];
    assert_eq!(
        d["voice"],
        serde_json::json!({"dataUrl": "data:audio/mp4;base64,AAAA", "duration": 1.5})
    );
    assert_eq!(d["replyTo"]["id"], "m-0");
    assert_eq!(d["replyTo"]["media"], "image");
    assert_eq!(
        d["replyTo"]["text"].as_str().map(|t| t.chars().count()),
        Some(200)
    );
    assert_eq!(d["forwardedFrom"], serde_json::json!({"login": "carol"}));
    assert!(d.get("editOf").is_none());
}

#[test]
fn receipts_are_exact() {
    assert_eq!(
        ack(&login("alice"), &id("m-1")).expect("ack"),
        r#"{"k":"frame","to":"alice","d":{"t":"ack","id":"m-1"}}"#
    );
    assert_eq!(
        read(&login("alice"), &id("m-1")).expect("read"),
        r#"{"k":"frame","to":"alice","d":{"t":"read","id":"m-1"}}"#
    );
}

#[test]
fn edit_delete_and_react_are_exact() {
    assert_eq!(
        edit(&login("bob"), &id("m-3"), "new text", Some("op-1")).expect("edit"),
        r#"{"k":"frame","to":"bob","d":{"t":"edit","id":"m-3","text":"new text","opId":"op-1"}}"#
    );
    assert_eq!(
        edit(&login("bob"), &id("m-3"), "new text", None).expect("edit"),
        r#"{"k":"frame","to":"bob","d":{"t":"edit","id":"m-3","text":"new text"}}"#
    );
    assert_eq!(
        del(
            &login("bob"),
            &[id("m-1"), id("m-2")],
            Scope::All,
            Some("op-9")
        )
        .expect("del"),
        r#"{"k":"frame","to":"bob","d":{"t":"del","ids":["m-1","m-2"],"scope":"all","opId":"op-9"}}"#
    );
    assert_eq!(
        del(&login("bob"), &[id("m-1")], Scope::SelfOnly, None).expect("del"),
        r#"{"k":"frame","to":"bob","d":{"t":"del","ids":["m-1"],"scope":"self"}}"#
    );
    assert_eq!(
        react(&login("bob"), &id("m-1"), "👍", true, Some("op-1")).expect("react"),
        r#"{"k":"frame","to":"bob","d":{"t":"react","id":"m-1","emoji":"👍","add":true,"opId":"op-1"}}"#
    );
    assert_eq!(
        react(&login("bob"), &id("m-1"), "👍", false, None).expect("react"),
        r#"{"k":"frame","to":"bob","d":{"t":"react","id":"m-1","emoji":"👍","add":false}}"#
    );
}

#[test]
fn typing_is_exact() {
    assert_eq!(
        typing(&login("bob"), true, Some("Alice")).expect("typing"),
        r#"{"k":"frame","to":"bob","d":{"t":"typing","state":"start","name":"Alice"}}"#
    );
    assert_eq!(
        typing(&login("bob"), false, None).expect("typing"),
        r#"{"k":"frame","to":"bob","d":{"t":"typing","state":"stop"}}"#
    );
}

#[test]
fn sync_and_its_limits_are_exact() {
    assert_eq!(
        sync_request(Seq(1050), 200).expect("sync"),
        r#"{"k":"sync","since":1050,"limit":200}"#
    );
    assert_eq!(
        sync_request(Seq(-3), 0).expect("sync"),
        r#"{"k":"sync","since":0,"limit":1}"#
    );
    assert_eq!(
        sync_request(Seq(0), 10_000).expect("sync"),
        r#"{"k":"sync","since":0,"limit":500}"#
    );
}

#[test]
fn mark_read_and_state_are_exact() {
    assert_eq!(
        mark_read(&login("bob")).expect("mark-read"),
        r#"{"k":"mark-read","peer":"bob"}"#
    );
    assert_eq!(
        state(PresenceState::Idle).expect("state"),
        r#"{"k":"state","state":"idle"}"#
    );
    assert_eq!(
        state(PresenceState::Active).expect("state"),
        r#"{"k":"state","state":"active"}"#
    );
    assert_eq!(
        state(PresenceState::Away).expect("state"),
        r#"{"k":"state","state":"away"}"#
    );
}

#[test]
fn a_delete_names_between_one_and_the_servers_limit() {
    assert!(matches!(
        del(&login("bob"), &[], Scope::All, None),
        Err(CoreError::InvalidIdCount {
            count: 0,
            max: DELETE_IDS_MAX
        })
    ));

    let too_many: Vec<MessageId> = (0..=DELETE_IDS_MAX)
        .map(|i| id(&format!("m-{i}")))
        .collect();
    assert!(matches!(
        del(&login("bob"), &too_many, Scope::All, None),
        Err(CoreError::InvalidIdCount { count, max })
            if count == DELETE_IDS_MAX + 1 && max == DELETE_IDS_MAX
    ));

    let full: Vec<MessageId> = (0..DELETE_IDS_MAX).map(|i| id(&format!("m-{i}"))).collect();
    assert!(del(&login("bob"), &full, Scope::All, None).is_ok());
}

#[test]
fn a_picture_frame_is_exactly_what_the_server_expects() {
    let picture = super::inner::Image {
        data_url: "data:image/png;base64,AAAA".into(),
        width: Some(640),
        height: Some(480),
    };
    let message = Outgoing {
        extra: Default::default(),
        id: id("m-1"),
        peer: login("bob"),
        ts: Ts(5),
        text: String::new(),
        image: Some(picture.clone()),
        receipt: Receipt::Queued,
    };
    assert_eq!(
        msg(&message).expect("msg frame"),
        r#"{"k":"frame","to":"bob","d":{"t":"msg","id":"m-1","ts":5,"text":"","image":{"dataUrl":"data:image/png;base64,AAAA","width":640,"height":480}}}"#
    );
    // A caption travels beside the picture; an unknown size is left out, and
    // the server's own default then stands (`normalizeMedia`).
    let caption = Outgoing {
        text: "look".into(),
        image: Some(super::inner::Image {
            width: None,
            height: None,
            ..picture
        }),
        ..message
    };
    assert_eq!(
        msg(&caption).expect("msg frame"),
        r#"{"k":"frame","to":"bob","d":{"t":"msg","id":"m-1","ts":5,"text":"look","image":{"dataUrl":"data:image/png;base64,AAAA"}}}"#
    );
}

#[test]
fn an_oversized_message_is_refused_before_it_reaches_the_socket() {
    let message = Outgoing {
        extra: Default::default(),
        id: id("m-1"),
        peer: login("bob"),
        ts: Ts(1),
        text: "a".repeat(MAX_OUTBOUND),
        image: None,
        receipt: Receipt::Queued,
    };
    assert!(matches!(
        msg(&message),
        Err(CoreError::FrameTooLarge { .. })
    ));
}

#[test]
fn every_encoder_stays_inside_the_outbound_limit() {
    // Not a size test of each frame, but of the check every encoder shares:
    // a frame that fits has to come back as text, never as an error.
    let text = "x".repeat(1024);
    let frames = [
        subscribe(&login("bob")),
        msg(&Outgoing {
            extra: Default::default(),
            id: id("m-1"),
            peer: login("bob"),
            ts: Ts(1),
            text: text.clone(),
            image: None,
            receipt: Receipt::Queued,
        }),
        edit(&login("bob"), &id("m-1"), &text, None),
        react(&login("bob"), &id("m-1"), "👍", true, None),
        typing(&login("bob"), true, Some(&text)),
        del(&login("bob"), &[id("m-1")], Scope::All, None),
        sync_request(Seq(0), 200),
        mark_read(&login("bob")),
        state(PresenceState::Away),
    ];
    for frame in frames {
        let json = frame.expect("encodes");
        assert!(json.len() <= MAX_OUTBOUND);
    }
}

/// R3: the inline form is the one every core reads. A core before 1.148 read
/// the decrypted header as the body straight away; this core first puts a
/// blob back (`attach_media`). Both readings of the same inline header give
/// the same picture and the same voice note, and neither counts it as lost.
#[test]
fn the_inline_form_is_read_by_the_old_and_the_new_core_alike() {
    use serde_json::{Value, json};

    use super::inner::{MessageBody, attach_media};

    let picture = "data:image/webp;base64,QUJDRA==";
    let voice = "data:audio/mp4;base64,RUZHSA==";
    for header in [
        json!({"text": "cap", "image": {"dataUrl": picture, "width": 4, "height": 3}}),
        json!({"text": "cap", "voice": {"dataUrl": voice, "duration": 2.5, "waveform": [1, 2]}}),
    ] {
        let Value::Object(map) = header else {
            unreachable!()
        };
        let old: MessageBody = serde_json::from_value(Value::Object(map.clone())).unwrap();
        let mut rebuilt = map.clone();
        assert!(!attach_media(&mut rebuilt, None), "nothing lost");
        let new: MessageBody = serde_json::from_value(Value::Object(rebuilt)).unwrap();
        assert_eq!(old, new);
        assert!(old.image.is_some() || old.voice.is_some(), "{map:?}");
        if let Some(image) = &old.image {
            assert_eq!(image.data_url, picture);
            assert_eq!((image.width, image.height), (Some(4), Some(3)));
        }
        if let Some(note) = &old.voice {
            assert_eq!(note.data_url, voice);
            assert_eq!(note.duration, Some(2.5));
        }
    }
}

/// The blob form, by contrast, is what an old core loses: read straight
/// away its header has no picture. `attach_media` reports what this core
/// itself cannot put back — the guard for the next change of form.
#[test]
fn attach_media_says_when_an_attachment_cannot_be_put_back() {
    use serde_json::{Map, Value, json};

    use super::inner::{MessageBody, attach_media};

    let object = |v: Value| -> Map<String, Value> {
        let Value::Object(map) = v else {
            unreachable!()
        };
        map
    };
    let blob_form = object(json!({"text": "c", "image": {"mime": "image/png"}}));
    let old: MessageBody = serde_json::from_value(Value::Object(blob_form.clone())).unwrap();
    assert!(
        old.image.is_none(),
        "the old core's reading of the blob form"
    );
    let mut new = blob_form.clone();
    assert!(!attach_media(&mut new, Some(b"xyz")));
    assert!(new["image"]["dataUrl"].is_string());

    let cases: [(Value, Option<&[u8]>, bool); 5] = [
        (
            json!({"text": "c", "image": {"mime": "image/png"}}),
            None,
            true,
        ),
        (
            json!({"text": "c", "voice": {"mime": "audio/ogg"}}),
            None,
            true,
        ),
        (
            json!({"text": "c", "image": {"ref": "abc"}}),
            Some(b"x"),
            true,
        ),
        (
            json!({"text": "c", "file": {"name": "a"}}),
            Some(b"x"),
            true,
        ),
        (json!({"text": "c"}), None, false),
    ];
    for (header, blob, lost) in cases {
        let mut map = object(header.clone());
        assert_eq!(attach_media(&mut map, blob), lost, "{header}");
    }
}
