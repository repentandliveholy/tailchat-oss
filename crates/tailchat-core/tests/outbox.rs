//! Public outbox behavior: queue limits, retries, receipts and storage failure.

mod common;

#[cfg(test)]
mod cases {
    use tailchat_core::{
        Action, Core, CoreError, Event, Image, Input, Login, MessageId, Outgoing, Output,
        PeerReceipts, PendingOutgoing, Receipt, Storage, Token, Ts,
    };

    use super::common::MemStore as Store;

    const READY: &str =
        r#"{"k":"ready","users":[{"login":"bob","online":false},{"login":"carol"}]}"#;

    fn login(s: &str) -> Login {
        Login::parse(s).unwrap()
    }
    fn id(s: &str) -> MessageId {
        MessageId::parse(s).unwrap()
    }
    fn key(m: &Outgoing, peer: &Login, id: &MessageId) -> bool {
        m.peer == *peer && m.id == *id
    }

    struct Client {
        core: Core,
        store: Store,
        wire: Vec<serde_json::Value>,
        events: Vec<Event>,
    }

    impl Client {
        fn new() -> Self {
            Self::restore(Store::default())
        }
        fn restore(store: Store) -> Self {
            let core = Core::new(
                login("alice"),
                Token::parse(&"a".repeat(64)).unwrap(),
                store.load().unwrap(),
            );
            Self {
                core,
                store,
                wire: Vec::new(),
                events: Vec::new(),
            }
        }
        fn step(&mut self, now: i64, input: Input) -> Result<(), CoreError> {
            let outputs = self.core.handle(Ts(now), input)?;
            for output in outputs {
                match output {
                    Output::Send(frame) => self.wire.push(serde_json::from_str(&frame).unwrap()),
                    Output::Event(event) => self.events.push(event),
                    Output::Fetch(_) => {}
                    Output::Post(request) => panic!("encryption is off: {request:?}"),
                    Output::Persist(ops) => {
                        if self.store.apply(&ops).is_err() {
                            self.core = Core::new(
                                login("alice"),
                                Token::parse(&"a".repeat(64)).unwrap(),
                                self.store.load().unwrap(),
                            );
                            break;
                        }
                    }
                }
            }
            Ok(())
        }
        fn frame(&mut self, now: i64, frame: &str) {
            self.step(now, Input::Frame(frame.into())).unwrap();
        }
        fn send(&mut self, now: i64, peer: &str, mid: &str) -> Result<(), CoreError> {
            self.step(
                now,
                Input::Action(Action::SendText {
                    peer: login(peer),
                    id: id(mid),
                    text: "hello".into(),
                }),
            )
        }
        fn send_image(
            &mut self,
            now: i64,
            peer: &str,
            mid: &str,
            text: &str,
            data_url: &str,
        ) -> Result<(), CoreError> {
            self.step(
                now,
                Input::Action(Action::SendImage {
                    peer: login(peer),
                    id: id(mid),
                    text: text.into(),
                    image: Image {
                        data_url: data_url.into(),
                        width: Some(640),
                        height: Some(480),
                    },
                }),
            )
        }
        fn accept(&mut self, mid: &str, peer: &str, ts: i64) {
            self.frame(
                ts,
                &format!(r#"{{"k":"message-accepted","peer":"{peer}","id":"{mid}","ts":{ts}}}"#),
            );
        }
        fn pending(&self, mid: &str, peer: &str) -> &PendingOutgoing {
            self.store
                .snapshot
                .pending
                .iter()
                .find(|r| key(&r.message, &login(peer), &id(mid)))
                .unwrap()
        }
        fn sent(&self, mid: &str, peer: &str) -> &Outgoing {
            self.store
                .snapshot
                .sent
                .iter()
                .find(|m| key(m, &login(peer), &id(mid)))
                .unwrap()
        }
        fn wake(&mut self) {
            let now = self.core.next_wakeup().expect("scheduled retry");
            self.step(now.0, Input::Tick).unwrap();
        }
    }

    #[test]
    fn readiness_tracks_connection_and_authentication() {
        let mut c = Client::new();
        assert!(!c.core.is_ready());
        c.step(0, Input::Connected).unwrap();
        assert!(!c.core.is_ready());
        c.frame(1, READY);
        assert!(c.core.is_ready());
        c.step(2, Input::Disconnected).unwrap();
        assert!(!c.core.is_ready());
        c.step(3, Input::Connected).unwrap();
        c.frame(4, READY);
        assert!(c.core.is_ready());
        c.frame(5, r#"{"k":"error","code":"auth_failed"}"#);
        assert!(!c.core.is_ready());
        c.frame(6, READY);
        c.frame(7, r#"{"k":"error","code":"auth_required"}"#);
        assert!(!c.core.is_ready());
        c.frame(8, READY);
        c.step(
            9,
            Input::SendFailed {
                peer: login("bob"),
                id: id("m-1"),
            },
        )
        .unwrap();
        assert!(!c.core.is_ready());
        c.frame(10, READY);
        c.step(11, Input::Connected).unwrap();
        assert!(!c.core.is_ready());
    }

    #[test]
    fn extra_capabilities_apply_to_every_connection_and_can_be_replaced() {
        let mut c = Client::new();
        c.step(0, Input::Connected).unwrap();
        assert_eq!(
            c.wire.last().unwrap()["caps"],
            serde_json::json!(["durable-ack", "addressed-send", "sync-nudge-v1"])
        );
        c.core.set_extra_caps(vec![
            "read-ack-v1".into(),
            "durable-ack".into(),
            "read-ack-v1".into(),
            "bad cap".into(),
        ]);
        for now in [1, 2] {
            c.step(now, Input::Disconnected).unwrap();
            c.step(now, Input::Connected).unwrap();
            assert_eq!(
                c.wire.last().unwrap()["caps"],
                serde_json::json!([
                    "durable-ack",
                    "addressed-send",
                    "sync-nudge-v1",
                    "read-ack-v1"
                ])
            );
        }
        c.core.set_extra_caps(vec!["another".into()]);
        c.step(3, Input::Connected).unwrap();
        assert_eq!(
            c.wire.last().unwrap()["caps"],
            serde_json::json!(["durable-ack", "addressed-send", "sync-nudge-v1", "another"])
        );
        c.core.set_extra_caps(Vec::new());
        c.step(4, Input::Connected).unwrap();
        assert_eq!(
            c.wire.last().unwrap()["caps"],
            serde_json::json!(["durable-ack", "addressed-send", "sync-nudge-v1"])
        );
    }

    #[test]
    fn offline_ticks_spend_no_attempts_and_reconnect_resends_immediately() {
        let mut c = Client::new();
        c.send(0, "bob", "m-1").unwrap();
        for t in [1000, 10_000, 1_000_000] {
            c.step(t, Input::Tick).unwrap();
        }
        assert!(c.wire.is_empty());
        assert_eq!(c.pending("m-1", "bob").attempts, 0);
        assert_eq!(c.core.next_wakeup(), None);
        c.frame(1_000_000, READY);
        assert_eq!(c.pending("m-1", "bob").attempts, 1);
        c.step(1_000_001, Input::Disconnected).unwrap();
        c.frame(1_000_002, READY);
        assert_eq!(c.pending("m-1", "bob").attempts, 2);
        assert_eq!(c.wire[0], c.wire[1], "retry keeps id, timestamp and text");
    }

    #[test]
    fn eighth_unanswered_attempt_fails_then_manual_retry_reuses_the_id() {
        let mut c = Client::new();
        c.frame(0, READY);
        c.send(0, "bob", "m-1").unwrap();
        for n in 2..=8 {
            let previous = c.pending("m-1", "bob").next_attempt_at;
            c.wake();
            assert_eq!(c.pending("m-1", "bob").attempts, n);
            assert!(c.pending("m-1", "bob").next_attempt_at > previous);
        }
        c.wake();
        assert_eq!(c.wire.len(), 8);
        assert_eq!(c.pending("m-1", "bob").message.receipt, Receipt::Failed);
        assert_eq!(c.core.next_wakeup(), None);
        let retry_at = c.pending("m-1", "bob").next_attempt_at.0;
        c.step(
            retry_at,
            Input::Action(Action::Retry {
                peer: login("bob"),
                id: id("m-1"),
            }),
        )
        .unwrap();
        assert_eq!(c.wire.len(), 9);
        assert_eq!(c.wire[0], c.wire[8]);
        assert_eq!(c.pending("m-1", "bob").attempts, 1);
        c.accept("m-1", "bob", retry_at);
        assert_eq!(c.sent("m-1", "bob").receipt, Receipt::Sent);
    }

    #[test]
    fn retry_deadlines_are_exponential_with_bounded_jitter() {
        let mut c = Client::new();
        c.frame(0, READY);
        c.send(0, "bob", "m-1").unwrap();
        let mut written_at = 0;
        for attempt in 1..=8 {
            let deadline = c.pending("m-1", "bob").next_attempt_at.0;
            let base = 1000_i64 << (attempt - 1);
            assert!((base..=(base + base / 4)).contains(&(deadline - written_at)));
            written_at = deadline;
            c.wake();
        }
        assert_eq!(c.pending("m-1", "bob").message.receipt, Receipt::Failed);
    }

    #[test]
    fn failed_attempt_metadata_commit_cannot_send_or_lose_the_queued_row() {
        let mut c = Client::new();
        c.send(0, "bob", "m-1").unwrap();
        c.store.fail = true;
        c.frame(0, READY);
        assert!(c.wire.is_empty());
        assert_eq!(c.pending("m-1", "bob").attempts, 0);
        c.frame(1, READY);
        assert_eq!(c.wire.len(), 1);
        assert_eq!(c.pending("m-1", "bob").attempts, 1);
    }

    #[test]
    fn attempt_budget_survives_a_restart() {
        let mut c = Client::new();
        c.frame(0, READY);
        c.send(0, "bob", "m-1").unwrap();
        for _ in 1..8 {
            c.wake();
        }
        let mut c = Client::restore(c.store);
        c.frame(1_000_000, READY);
        assert!(
            c.wire.is_empty(),
            "restart cannot grant a ninth automatic attempt"
        );
        assert_eq!(c.pending("m-1", "bob").message.receipt, Receipt::Failed);
    }

    #[test]
    fn store_failure_retries_but_permanent_refusals_fail_only_the_matching_peer() {
        let mut c = Client::new();
        c.send(0, "bob", "shared-id").unwrap();
        c.send(0, "carol", "shared-id").unwrap();
        c.frame(0, READY);
        c.frame(
            1,
            r#"{"k":"error","code":"store_failed","peer":"bob","id":"shared-id"}"#,
        );
        assert_eq!(
            c.pending("shared-id", "bob").message.receipt,
            Receipt::Queued
        );
        c.frame(
            2,
            r#"{"k":"error","code":"message_id_conflict","peer":"bob","id":"shared-id"}"#,
        );
        assert_eq!(
            c.pending("shared-id", "bob").message.receipt,
            Receipt::Failed
        );
        assert_eq!(
            c.pending("shared-id", "carol").message.receipt,
            Receipt::Queued
        );
        c.wake();
        assert_eq!(c.wire.last().unwrap()["to"], "carol");
    }

    #[test]
    fn duplicate_action_does_not_replace_text_or_charge_an_attempt() {
        let mut c = Client::new();
        c.send(0, "bob", "m-1").unwrap();
        let before = c.store.load().unwrap();
        assert_eq!(c.send(0, "bob", "m-1"), Err(CoreError::DuplicateMessageId));
        assert_eq!(c.store.load().unwrap(), before);
        assert_eq!(
            c.step(
                0,
                Input::Action(Action::Retry {
                    peer: login("bob"),
                    id: id("m-1")
                })
            ),
            Err(CoreError::NotRetryable)
        );
    }

    #[test]
    fn full_queue_rejects_new_rows_without_eviction_and_is_per_conversation() {
        let mut c = Client::new();
        for n in 0..1000 {
            c.send(0, "bob", &format!("m-{n}")).unwrap();
        }
        assert_eq!(
            c.send(0, "bob", "overflow"),
            Err(CoreError::QueueFull { limit: 1000 })
        );
        assert_eq!(c.store.snapshot.pending.len(), 1000);
        assert_eq!(c.pending("m-0", "bob").message.id, id("m-0"));
        assert_eq!(c.pending("m-999", "bob").message.id, id("m-999"));
        c.send(0, "carol", "overflow").unwrap();
    }

    #[test]
    fn queue_is_paced_and_round_robin_fair_even_with_retries_due() {
        let mut c = Client::new();
        for n in 0..40 {
            c.send(0, "bob", &format!("m-{n}")).unwrap();
        }
        c.frame(0, READY);
        while c.core.next_wakeup().unwrap().0 < 1000 {
            c.wake();
        }
        assert!(c.wire.len() <= 30);
        while c.wire.len() < 40 {
            c.wake();
        }
        let ids: std::collections::HashSet<_> = c
            .wire
            .iter()
            .map(|f| f["d"]["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), 40, "all initial sends precede any due retry");
    }

    #[test]
    fn throttle_refunds_a_dropped_write_instead_of_showing_failure() {
        let mut c = Client::new();
        c.frame(0, READY);
        c.send(0, "bob", "m-1").unwrap();
        for _ in 1..8 {
            c.wake();
        }
        let t = c.pending("m-1", "bob").next_attempt_at.0;
        c.frame(
            t - 1,
            r#"{"k":"throttle","windowMs":1000,"frames":61,"limit":60}"#,
        );
        assert_eq!(c.pending("m-1", "bob").attempts, 7);
        c.wake();
        assert_eq!(c.pending("m-1", "bob").attempts, 8);
        assert_eq!(c.pending("m-1", "bob").message.receipt, Receipt::Queued);
    }

    #[test]
    fn socket_write_failure_is_not_an_online_attempt() {
        let mut c = Client::new();
        c.frame(0, READY);
        c.send(0, "bob", "m-1").unwrap();
        c.step(
            1,
            Input::SendFailed {
                peer: login("bob"),
                id: id("m-1"),
            },
        )
        .unwrap();
        assert_eq!(c.pending("m-1", "bob").attempts, 0);
        assert_eq!(c.core.next_wakeup(), None);
        c.frame(2, READY);
        assert_eq!(c.pending("m-1", "bob").attempts, 1);
    }

    #[test]
    fn ready_validates_roster_but_allows_offline_friends_and_saved_messages() {
        let mut c = Client::new();
        c.send(0, "nobody", "bad").unwrap();
        c.send(0, "alice", "saved").unwrap();
        c.send(0, "bob", "friend").unwrap();
        c.frame(0, READY);
        assert_eq!(c.pending("bad", "nobody").message.receipt, Receipt::Failed);
        while c.wire.len() < 2 {
            c.wake();
        }
        assert_eq!(c.wire[0]["to"], "alice");
        assert_eq!(c.wire[1]["to"], "bob");
    }

    #[test]
    fn blocked_roster_rows_are_not_sendable() {
        let mut c = Client::new();
        c.send(0, "bob", "bad").unwrap();
        c.frame(
            0,
            r#"{"k":"ready","users":[{"login":"bob","blocked":true}]}"#,
        );
        assert!(c.wire.is_empty());
        assert_eq!(c.pending("bad", "bob").message.receipt, Receipt::Failed);
    }

    #[test]
    fn malformed_and_oversized_rows_do_not_stop_other_conversations() {
        let mut c = Client::new();
        c.frame(0, "{");
        assert!(matches!(c.events.last(), Some(Event::BadFrame { .. })));
        c.frame(0, READY);
        c.step(
            0,
            Input::Action(Action::SendText {
                id: id("big"),
                peer: login("bob"),
                text: "x".repeat(tailchat_core::MAX_OUTBOUND),
            }),
        )
        .unwrap();
        c.send(0, "carol", "small").unwrap();
        assert_eq!(c.pending("big", "bob").message.receipt, Receipt::Failed);
        assert_eq!(c.wire.len(), 1);
        assert_eq!(c.wire[0]["d"]["id"], "small");
    }

    #[test]
    fn watermark_never_commits_a_queued_message_and_uses_the_server_timestamp() {
        let mut c = Client::new();
        c.send(1000, "bob", "m-1").unwrap();
        c.step(
            1000,
            Input::PeerReceipts(PeerReceipts {
                peer: login("bob"),
                delivered_ts: None,
                read_ts: Some(Ts(1500)),
            }),
        )
        .unwrap();
        assert_eq!(c.pending("m-1", "bob").message.receipt, Receipt::Queued);
        c.accept("m-1", "bob", 2000);
        assert_eq!(
            c.sent("m-1", "bob").receipt,
            Receipt::Sent,
            "server time is newer than the read position"
        );
        c.frame(
            2001,
            r#"{"k":"frame","from":"bob","d":{"t":"read","id":"m-1","readTs":2000}}"#,
        );
        assert_eq!(c.sent("m-1", "bob").receipt, Receipt::Read);
        c.frame(
            2002,
            r#"{"k":"frame","from":"bob","d":{"t":"ack","id":"m-1","deliveredTs":1900}}"#,
        );
        assert_eq!(c.sent("m-1", "bob").receipt, Receipt::Read);
        let c = Client::restore(c.store);
        assert_eq!(c.sent("m-1", "bob").receipt, Receipt::Read);
        let watermark = &c.store.snapshot.receipts[0];
        assert_eq!(watermark.delivered_ts, Some(Ts(2000)));
    }

    #[test]
    fn delivery_and_saved_watermarks_survive_restart_and_apply_to_late_acceptance() {
        let mut c = Client::new();
        c.send(0, "bob", "m-1").unwrap();
        c.frame(
            1,
            r#"{"k":"frame","from":"bob","d":{"t":"ack","id":"m-1","deliveredTs":10}}"#,
        );
        assert_eq!(c.pending("m-1", "bob").message.receipt, Receipt::Queued);
        let mut c = Client::restore(c.store);
        c.accept("m-1", "bob", 10);
        assert_eq!(c.sent("m-1", "bob").receipt, Receipt::Delivered);
        c.frame(
            11,
            r#"{"k":"frame","from":"bob","self":true,"d":{"t":"read","id":"m-1","readTs":10}}"#,
        );
        assert_eq!(
            c.sent("m-1", "bob").receipt,
            Receipt::Delivered,
            "own-device receipts are not peer reads"
        );
    }

    #[test]
    fn failed_row_can_still_be_accepted_but_wrong_peer_and_duplicate_ack_change_nothing() {
        let mut c = Client::new();
        c.send(0, "bob", "m-1").unwrap();
        c.frame(
            0,
            r#"{"k":"error","code":"blocked","peer":"bob","id":"m-1"}"#,
        );
        c.accept("m-1", "carol", 10);
        assert_eq!(c.pending("m-1", "bob").message.receipt, Receipt::Failed);
        c.accept("m-1", "bob", 10);
        assert_eq!(c.sent("m-1", "bob").receipt, Receipt::Sent);
        c.accept("m-1", "bob", 20);
        assert_eq!(c.sent("m-1", "bob").ts, Ts(10));
    }

    #[test]
    fn disk_failure_aborts_the_output_batch_before_any_send() {
        let mut c = Client::new();
        c.frame(0, READY);
        c.store.fail = true;
        c.send(0, "bob", "m-1").unwrap();
        assert!(c.wire.is_empty());
        assert!(c.store.snapshot.pending.is_empty());
        assert_eq!(
            c.core.next_wakeup(),
            None,
            "driver rebuilt a non-ready core from disk"
        );
    }

    #[test]
    fn lost_acceptance_commit_is_recovered_by_resending_the_original_row() {
        let mut c = Client::new();
        c.frame(0, READY);
        c.send(0, "bob", "m-1").unwrap();
        c.store.fail = true;
        c.accept("m-1", "bob", 10);
        assert!(c.store.snapshot.sent.is_empty());
        c.frame(11, READY);
        assert_eq!(c.wire[0], c.wire[1]);
        c.accept("m-1", "bob", 10);
        assert_eq!(c.sent("m-1", "bob").receipt, Receipt::Sent);
    }

    #[test]
    fn auth_failure_stops_timers_without_spending_attempts() {
        let mut c = Client::new();
        c.frame(0, READY);
        c.send(0, "bob", "m-1").unwrap();
        c.frame(1, r#"{"k":"error","code":"auth_failed"}"#);
        c.step(1_000_000, Input::Tick).unwrap();
        assert_eq!(c.core.next_wakeup(), None);
        assert_eq!(c.pending("m-1", "bob").attempts, 1);
    }

    /// The picture travels in the open exactly as the server stores media
    /// (`normalizeMedia`), and a blank caption beside it is allowed.
    #[test]
    fn a_picture_goes_as_the_exact_open_frame_with_its_caption() {
        let mut c = Client::new();
        c.frame(5, READY);
        c.send_image(5, "bob", "m-1", "", "data:image/png;base64,AAAA")
            .unwrap();
        assert_eq!(
            c.wire.last().unwrap(),
            &serde_json::json!({"k": "frame", "to": "bob", "d": {
                "t": "msg", "id": "m-1", "ts": 5, "text": "",
                "image": {"dataUrl": "data:image/png;base64,AAAA", "width": 640, "height": 480}
            }})
        );
        assert_eq!(
            c.pending("m-1", "bob").message.image.as_ref(),
            Some(&Image {
                data_url: "data:image/png;base64,AAAA".into(),
                width: Some(640),
                height: Some(480),
            })
        );
        // A receipt upgrade keeps the picture on the committed row.
        c.accept("m-1", "bob", 9);
        assert_eq!(
            c.sent("m-1", "bob")
                .image
                .as_ref()
                .map(|i| i.data_url.as_str()),
            Some("data:image/png;base64,AAAA")
        );
    }

    /// A restart re-sends the picture byte for byte: the row carries it.
    #[test]
    fn a_queued_picture_survives_a_restart_and_goes_again_unchanged() {
        let mut c = Client::new();
        c.frame(0, READY);
        c.send_image(0, "bob", "m-1", "caption", "data:image/webp;base64,AAAA")
            .unwrap();
        let first = c.wire.last().unwrap().clone();
        let store = c.store.clone();
        let mut again = Client::restore(store);
        again.step(1, Input::Connected).unwrap();
        again.frame(2, READY);
        assert_eq!(again.wire.last().unwrap(), &first);
        // Restarting charges nothing; this one new write is the second.
        assert_eq!(again.pending("m-1", "bob").attempts, 2);
    }

    /// Nothing reaches the queue that no frame can carry.
    #[test]
    fn a_picture_must_fit_the_history_media_limit_not_just_the_frame() {
        let mut c = Client::new();
        c.frame(0, READY);
        // The base64 alone fits 10 MiB, but its data URL prefix pushes it
        // over normalizeMedia's independent ceiling. The enclosing frame
        // would still fit its additional 1024 bytes of headroom.
        let url = format!("data:image/png;base64,{}", "A".repeat(10 * 1024 * 1024));
        assert!(matches!(
            c.send_image(0, "bob", "media-limit", "", &url),
            Err(CoreError::FrameTooLarge {
                max: 10_485_760,
                ..
            })
        ));
        assert!(c.store.snapshot.pending.is_empty());
    }

    #[test]
    fn an_open_picture_does_not_need_to_fit_an_unused_encrypted_frame() {
        let mut c = Client::new();
        c.frame(0, READY);
        c.send_image(
            0,
            "bob",
            "long-caption",
            &"a".repeat(8_000_000),
            "data:image/png;base64,AA==",
        )
        .unwrap();
        assert_eq!(
            c.wire.last().unwrap()["d"]["text"].as_str().unwrap().len(),
            8_000_000
        );
        assert_eq!(c.pending("long-caption", "bob").attempts, 1);
    }

    /// Nothing reaches the queue that no frame can carry.
    #[test]
    fn a_picture_no_frame_can_carry_is_refused_and_nothing_is_queued() {
        let mut c = Client::new();
        c.step(0, Input::Connected).unwrap();
        c.frame(1, READY);
        let sent_before = c.wire.len();

        let refused = |c: &mut Client, data_url: &str| {
            c.send_image(0, "bob", "m-1", "", data_url).unwrap_err()
        };
        assert_eq!(
            refused(&mut c, "https://example.com/cat.png"),
            CoreError::InvalidImage {
                reason: "not a data:image/{jpeg,png,gif,webp};base64 picture, or its base64 does not decode",
            }
        );
        assert_eq!(
            refused(&mut c, "data:image/svg+xml;base64,AAAA"),
            CoreError::InvalidImage {
                reason: "not a data:image/{jpeg,png,gif,webp};base64 picture, or its base64 does not decode",
            }
        );
        assert_eq!(
            refused(&mut c, "data:image/png;base64,!!!!"),
            CoreError::InvalidImage {
                reason: "not a data:image/{jpeg,png,gif,webp};base64 picture, or its base64 does not decode",
            }
        );
        let huge = format!(
            "data:image/png;base64,{}",
            "A".repeat(tailchat_core::MAX_OUTBOUND)
        );
        assert!(matches!(
            refused(&mut c, &huge),
            CoreError::FrameTooLarge { .. }
        ));
        assert!(c.store.snapshot.pending.is_empty(), "nothing was queued");
        assert!(
            c.wire
                .iter()
                .skip(sent_before)
                .all(|frame| frame["k"] != "frame"),
            "no message frame was written"
        );

        // Blank text is still refused for a message without a picture.
        assert_eq!(
            c.step(
                0,
                Input::Action(Action::SendText {
                    id: id("m-2"),
                    peer: login("bob"),
                    text: " ".into(),
                }),
            )
            .unwrap_err(),
            CoreError::EmptyText
        );
    }
}
