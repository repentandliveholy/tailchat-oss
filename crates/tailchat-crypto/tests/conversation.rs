//! Sub-stage 6b acceptance (`docs/specs/2026-11-04-e2ee.md` §8): two devices
//! talk, sessions rotate, and every server attack of §11 ends in
//! `Undecryptable`.

#[cfg(test)]
mod cases {
    use serde_json::{Map, Value, json};
    use tailchat_crypto::{
        Account, CryptoError, DeviceKeys, DeviceKind, Envelope, Frame, InboundGroup, MessageKind,
        OlmChannel, OutboundGroup, ROTATE_AFTER_MESSAGES, ROTATE_AFTER_MS, Received, Rotation,
        ToDevice, Undecryptable,
    };

    const NOW: u64 = 1_700_000_000_000;

    /// A device as the server knows it: its account, and its `keys/upload`
    /// body, from which others read its keys and claim its one-time keys.
    struct Device {
        account: Account,
        upload: Value,
    }

    impl Device {
        fn new(login: &str, device_id: &str) -> Self {
            let mut account = Account::new(login, device_id, DeviceKind::Client).unwrap();
            account.generate_one_time_keys(5);
            account.generate_fallback_key();
            let upload = account.upload_body().unwrap();
            account.mark_keys_as_published();
            Self { account, upload }
        }

        /// `keys/query`: the signed device keys, checked.
        fn keys(&self) -> DeviceKeys {
            DeviceKeys::from_json(&self.upload["deviceKeys"]).unwrap()
        }

        /// `keys/claim`: one signed one-time key.
        fn claim(&mut self) -> Value {
            let keys = self.upload["oneTimeKeys"].as_object_mut().unwrap();
            let id = keys.keys().next().unwrap().clone();
            keys.remove(&id).unwrap()
        }
    }

    fn text(body: &str) -> Map<String, Value> {
        json!({"text": body}).as_object().unwrap().clone()
    }

    fn msg<'a>(from: &'a str, to: &'a str, id: &'a str) -> Frame<'a> {
        Frame {
            from,
            to,
            id,
            kind: MessageKind::Msg,
        }
    }

    /// Send `key` from `sender` over a fresh Olm session to `recipient` and open
    /// it there, as `to-device` would.
    fn share(
        sender: &Device,
        recipient: &mut Device,
        outbound: &mut OutboundGroup,
    ) -> InboundGroup {
        let mut out = OlmChannel::new(recipient.keys());
        out.start_session(&sender.account, &recipient.claim())
            .unwrap();
        let body = out
            .encrypt(&sender.account, &ToDevice::RoomKey(outbound.room_key()))
            .unwrap();
        outbound.mark_shared(&recipient.keys());
        let mut inbound = OlmChannel::new(sender.keys());
        let Received::RoomKey(key) = inbound.decrypt(&mut recipient.account, &body).unwrap() else {
            panic!("not a room key");
        };
        assert_eq!(key.sender(), &sender.keys());
        InboundGroup::from_room_key(&recipient.account, *key).unwrap()
    }

    #[test]
    fn two_devices_talk_and_own_devices_read_along() {
        let a1 = Device::new("alice", "AAAAAAAAAAAAAAA1");
        let mut a2 = Device::new("alice", "AAAAAAAAAAAAAAA2");
        let mut b1 = Device::new("bob", "BBBBBBBBBBBBBBB1");

        let (mut outbound, mut own) = OutboundGroup::create(&a1.account, "bob", NOW);
        let mut at_bob = share(&a1, &mut b1, &mut outbound);
        let mut at_a2 = share(&a1, &mut a2, &mut outbound);
        assert!(outbound.unshared(&[b1.keys(), a2.keys()]).is_empty());

        let frame = msg("alice", "bob", "m-1");
        let envelope = outbound
            .encrypt(&a1.account, &frame, &text("hi"), None)
            .unwrap();
        assert_eq!(envelope.dev, "AAAAAAAAAAAAAAA1");
        assert_eq!(envelope.sid, outbound.session_id());
        let wire = Envelope::from_json(&envelope.to_json()).unwrap();

        for reader in [&mut at_bob, &mut at_a2, &mut own] {
            let read = reader.decrypt(&frame, &wire, None).unwrap();
            assert_eq!(read.content, text("hi"));
            assert_eq!(read.blob, None);
            assert_eq!(read.index, 0);
            // History or a reconnect hands the same envelope again.
            assert_eq!(reader.decrypt(&frame, &wire, None).unwrap().index, 0);
        }

        // A device that joins later reads from the current index on, not the
        // past (that is the backup's job, §4.3).
        let mut b2 = Device::new("bob", "BBBBBBBBBBBBBBB2");
        let mut late = share(&a1, &mut b2, &mut outbound);
        assert_eq!(late.first_known_index(), 1);
        assert_eq!(
            late.decrypt(&frame, &wire, None),
            Err(Undecryptable::BadCiphertext)
        );

        // An attachment travels as raw bytes inside the same ciphertext.
        let picture = vec![0_u8, 255, 1, 254, 7];
        let frame2 = msg("alice", "bob", "m-2");
        let envelope = outbound
            .encrypt(&a1.account, &frame2, &text(""), Some(&picture))
            .unwrap();
        let read = at_bob.decrypt(&frame2, &envelope, None).unwrap();
        assert_eq!(read.blob.as_deref(), Some(picture.as_slice()));
        assert_eq!(read.index, 1);
    }

    #[test]
    fn olm_channel_settles_into_normal_messages_both_ways() {
        let mut a1 = Device::new("alice", "AAAAAAAAAAAAAAA1");
        let mut b1 = Device::new("bob", "BBBBBBBBBBBBBBB1");

        let mut a_to_b = OlmChannel::new(b1.keys());
        a_to_b.start_session(&a1.account, &b1.claim()).unwrap();
        let first = a_to_b
            .encrypt(
                &a1.account,
                &ToDevice::Other {
                    kind: "ping".into(),
                    content: json!({"n": 1}),
                },
            )
            .unwrap();
        assert_eq!(first["type"], 0, "pre-key until the peer answers");

        let mut b_from_a = OlmChannel::new(a1.keys());
        let Received::Other { kind, content } = b_from_a.decrypt(&mut b1.account, &first).unwrap()
        else {
            panic!("not other");
        };
        assert_eq!((kind.as_str(), content), ("ping", json!({"n": 1})));

        // Bob answers on the session Alice started; no key claimed for it.
        let reply = b_from_a
            .encrypt(
                &b1.account,
                &ToDevice::Other {
                    kind: "pong".into(),
                    content: json!({}),
                },
            )
            .unwrap();
        let Received::Other { kind, .. } = a_to_b.decrypt(&mut a1.account, &reply).unwrap() else {
            panic!("not other");
        };
        assert_eq!(kind, "pong");
        let next = a_to_b
            .encrypt(
                &a1.account,
                &ToDevice::Other {
                    kind: "ping".into(),
                    content: json!({"n": 2}),
                },
            )
            .unwrap();
        assert_eq!(next["type"], 1, "normal once the peer answered");
        assert!(b_from_a.decrypt(&mut b1.account, &next).is_ok());

        // The same pre-key message again: its one-time key is gone, and the
        // session it opened is found by id instead.
        assert!(b_from_a.decrypt(&mut b1.account, &first).is_err());
    }

    #[test]
    fn state_survives_a_pickle_round_trip_mid_conversation() {
        let a1 = Device::new("alice", "AAAAAAAAAAAAAAA1");
        let mut b1 = Device::new("bob", "BBBBBBBBBBBBBBB1");
        let (mut outbound, _) = OutboundGroup::create(&a1.account, "bob", NOW);
        let at_bob = share(&a1, &mut b1, &mut outbound);
        let frame = msg("alice", "bob", "m-1");
        let first = outbound
            .encrypt(&a1.account, &frame, &text("one"), None)
            .unwrap();

        let account = Account::from_pickle(&a1.account.pickle().unwrap()).unwrap();
        let mut outbound = OutboundGroup::from_pickle(&outbound.pickle().unwrap()).unwrap();
        let mut at_bob = InboundGroup::from_pickle(&at_bob.pickle().unwrap()).unwrap();

        at_bob.decrypt(&frame, &first, None).unwrap();
        let frame2 = msg("alice", "bob", "m-2");
        let second = outbound
            .encrypt(&account, &frame2, &text("two"), None)
            .unwrap();
        assert_eq!(at_bob.decrypt(&frame2, &second, None).unwrap().index, 1);
        assert_eq!(outbound.unshared(&[b1.keys()]).len(), 0, "sharing survives");

        // Nothing secret in Debug.
        let debug = format!("{outbound:?} {at_bob:?} {:?}", outbound.room_key());
        assert!(debug.contains("[redacted]"));
        assert!(!debug.contains(&*outbound.pickle().unwrap()));
    }

    #[test]
    fn rotation_is_due_after_count_age_or_a_removed_device() {
        let a1 = Device::new("alice", "AAAAAAAAAAAAAAA1");
        let mut b1 = Device::new("bob", "BBBBBBBBBBBBBBB1");
        let b2 = Device::new("bob", "BBBBBBBBBBBBBBB2");
        let (mut outbound, _) = OutboundGroup::create(&a1.account, "bob", NOW);
        let _ = share(&a1, &mut b1, &mut outbound);

        let both = [b1.keys(), b2.keys()];
        assert_eq!(outbound.rotation_due(NOW, &both), None);
        assert_eq!(
            outbound.unshared(&both),
            vec![&both[1]],
            "a new device gets the key"
        );
        assert_eq!(
            outbound.rotation_due(NOW, &[b2.keys()]),
            Some(Rotation::DeviceRemoved)
        );
        assert_eq!(
            outbound.rotation_due(NOW + ROTATE_AFTER_MS, &both),
            Some(Rotation::Age)
        );
        assert_eq!(
            outbound.rotation_due(NOW - 1, &both),
            None,
            "a clock step back is not age"
        );

        // Keys changed under a known device id: another device, not an update.
        let impostor = Device::new("bob", "BBBBBBBBBBBBBBB1");
        assert_eq!(outbound.unshared(&[impostor.keys()]).len(), 1);
        assert_eq!(
            outbound.rotation_due(NOW, &[impostor.keys()]),
            Some(Rotation::DeviceRemoved)
        );

        for i in 0..ROTATE_AFTER_MESSAGES {
            let id = format!("m-{i}");
            outbound
                .encrypt(&a1.account, &msg("alice", "bob", &id), &text("x"), None)
                .unwrap();
        }
        assert_eq!(
            outbound.rotation_due(NOW, &both[..1]),
            Some(Rotation::Messages)
        );
    }

    #[test]
    fn a_key_the_peer_did_not_sign_is_refused() {
        let a1 = Device::new("alice", "AAAAAAAAAAAAAAA1");
        let mut b1 = Device::new("bob", "BBBBBBBBBBBBBBB1");
        let mallory = Device::new("mallory", "MMMMMMMMMMMMMMM1");
        let mut channel = OlmChannel::new(b1.keys());

        // The server swaps in a one-time key of its own.
        let mut claimed = b1.claim();
        claimed["key"] = mallory.upload["deviceKeys"]["keys"]["curve25519"].clone();
        assert_eq!(
            channel.start_session(&a1.account, &claimed),
            Err(CryptoError::BadSignature)
        );
        let mut unsigned = b1.claim();
        unsigned.as_object_mut().unwrap().remove("signatures");
        assert_eq!(
            channel.start_session(&a1.account, &unsigned),
            Err(CryptoError::BadSignature)
        );
        assert!(!channel.has_session());
        assert_eq!(
            channel
                .encrypt(
                    &a1.account,
                    &ToDevice::Other {
                        kind: "x".into(),
                        content: json!({})
                    }
                )
                .unwrap_err(),
            CryptoError::NoSession
        );
    }

    /// Alice's device, Bob's device, a session shared between them and one
    /// envelope of `alice → bob`, `m-1`.
    struct Scene {
        a1: Device,
        b1: Device,
        outbound: OutboundGroup,
        at_bob: InboundGroup,
        envelope: Envelope,
    }

    fn scene() -> Scene {
        let a1 = Device::new("alice", "AAAAAAAAAAAAAAA1");
        let mut b1 = Device::new("bob", "BBBBBBBBBBBBBBB1");
        let (mut outbound, _) = OutboundGroup::create(&a1.account, "bob", NOW);
        let at_bob = share(&a1, &mut b1, &mut outbound);
        let envelope = outbound
            .encrypt(&a1.account, &msg("alice", "bob", "m-1"), &text("hi"), None)
            .unwrap();
        Scene {
            a1,
            b1,
            outbound,
            at_bob,
            envelope,
        }
    }

    #[test]
    fn a_corrupted_envelope_is_undecryptable_not_an_error() {
        let Scene {
            mut at_bob,
            envelope,
            ..
        } = scene();
        let frame = msg("alice", "bob", "m-1");

        let flipped = Envelope {
            ct: flip_middle(&envelope.ct),
            ..envelope.clone()
        };
        assert_eq!(
            at_bob.decrypt(&frame, &flipped, None),
            Err(Undecryptable::BadCiphertext)
        );
        let half = envelope.ct.len() / 2;
        let truncated = Envelope {
            ct: envelope.ct[..half].to_owned(),
            ..envelope.clone()
        };
        assert!(matches!(
            at_bob.decrypt(&frame, &truncated, None),
            Err(Undecryptable::Malformed | Undecryptable::BadCiphertext)
        ));
        let garbage = Envelope {
            ct: "not base64!".into(),
            ..envelope.clone()
        };
        assert_eq!(
            at_bob.decrypt(&frame, &garbage, None),
            Err(Undecryptable::Malformed)
        );
        assert_eq!(
            Envelope::from_json(&json!({"v": 2, "dev": "d", "sid": "s", "ct": "c"})),
            Err(Undecryptable::Malformed)
        );
        assert_eq!(
            Envelope::from_json(&json!({"v": 1, "dev": "d"})),
            Err(Undecryptable::Malformed)
        );

        // The intact envelope still reads: a refusal changed nothing.
        assert!(at_bob.decrypt(&frame, &envelope, None).is_ok());
    }

    /// Change one base64 character in the middle, keeping it base64.
    fn flip_middle(ct: &str) -> String {
        let mut chars: Vec<char> = ct.chars().collect();
        let i = chars.len() / 2;
        chars[i] = if chars[i] == 'A' { 'B' } else { 'A' };
        chars.into_iter().collect()
    }

    #[test]
    fn the_server_cannot_move_a_ciphertext_to_another_conversation() {
        let Scene {
            a1,
            mut b1,
            mut outbound,
            ..
        } = scene();
        // A2 gets the key before the next message, so it could read it.
        let mut a2 = Device::new("alice", "AAAAAAAAAAAAAAA2");
        let mut at_a2 = share(&a1, &mut a2, &mut outbound);
        let frame = msg("alice", "bob", "m-2");
        let envelope = outbound
            .encrypt(&a1.account, &frame, &text("hi"), None)
            .unwrap();

        // Alice's other device is handed the frame filed under `alice → carol`.
        assert_eq!(
            at_a2.decrypt(&msg("alice", "carol", "m-2"), &envelope, None),
            Err(Undecryptable::WrongConversation)
        );
        assert!(at_a2.decrypt(&frame, &envelope, None).is_ok());
        // A key for a conversation Bob is not in is not accepted by Bob.
        let (other, _) = OutboundGroup::create(&a1.account, "carol", NOW);
        let mut channel = OlmChannel::new(b1.keys());
        channel.start_session(&a1.account, &b1.claim()).unwrap();
        let body = channel
            .encrypt(&a1.account, &ToDevice::RoomKey(other.room_key()))
            .unwrap();
        let Received::RoomKey(key) = OlmChannel::new(a1.keys())
            .decrypt(&mut b1.account, &body)
            .unwrap()
        else {
            panic!("not a room key");
        };
        assert_eq!(
            InboundGroup::from_room_key(&b1.account, *key).unwrap_err(),
            Undecryptable::WrongConversation
        );
    }

    #[test]
    fn the_server_cannot_change_id_kind_or_author() {
        let Scene {
            mut at_bob,
            envelope,
            ..
        } = scene();
        assert_eq!(
            at_bob.decrypt(&msg("alice", "bob", "m-2"), &envelope, None),
            Err(Undecryptable::FieldMismatch { field: "id" })
        );
        let as_edit = Frame {
            kind: MessageKind::Edit,
            ..msg("alice", "bob", "m-1")
        };
        assert_eq!(
            at_bob.decrypt(&as_edit, &envelope, Some("alice")),
            Err(Undecryptable::FieldMismatch { field: "kind" })
        );
        // Relabelled as Bob's own message: the session is Alice's.
        assert_eq!(
            at_bob.decrypt(&msg("bob", "alice", "m-1"), &envelope, None),
            Err(Undecryptable::WrongSender)
        );
        assert!(
            at_bob
                .decrypt(&msg("alice", "bob", "m-1"), &envelope, None)
                .is_ok()
        );
    }

    #[test]
    fn a_reused_message_index_is_a_replay() {
        // The hazard §6 orders Persist before Send for: the sender comes back
        // from a pickle older than its last send and encrypts a new message
        // under the same index.
        let a1 = Device::new("alice", "AAAAAAAAAAAAAAA1");
        let mut b1 = Device::new("bob", "BBBBBBBBBBBBBBB1");
        let (mut outbound, _) = OutboundGroup::create(&a1.account, "bob", NOW);
        let mut at_bob = share(&a1, &mut b1, &mut outbound);
        let before_send = outbound.pickle().unwrap();
        let first = outbound
            .encrypt(&a1.account, &msg("alice", "bob", "m-1"), &text("one"), None)
            .unwrap();
        let mut rewound = OutboundGroup::from_pickle(&before_send).unwrap();
        let second = rewound
            .encrypt(
                &a1.account,
                &msg("alice", "bob", "m-9"),
                &text("other"),
                None,
            )
            .unwrap();

        assert_eq!(
            at_bob
                .decrypt(&msg("alice", "bob", "m-1"), &first, None)
                .unwrap()
                .index,
            0
        );
        assert_eq!(
            at_bob.decrypt(&msg("alice", "bob", "m-9"), &second, None),
            Err(Undecryptable::Replay { index: 0 })
        );
        // Which id index 0 carried survives storage.
        let mut stored = InboundGroup::from_pickle(&at_bob.pickle().unwrap()).unwrap();
        assert_eq!(
            stored.decrypt(&msg("alice", "bob", "m-9"), &second, None),
            Err(Undecryptable::Replay { index: 0 })
        );
        // The server replaying m-1 under the new id fails earlier: the id is
        // inside the ciphertext.
        assert_eq!(
            stored.decrypt(&msg("alice", "bob", "m-9"), &first, None),
            Err(Undecryptable::FieldMismatch { field: "id" })
        );
    }

    #[test]
    fn the_server_cannot_swap_dev_or_sid() {
        let Scene {
            a1,
            mut b1,
            mut at_bob,
            envelope,
            ..
        } = scene();
        let frame = msg("alice", "bob", "m-1");
        let wrong_dev = Envelope {
            dev: "AAAAAAAAAAAAAAA2".into(),
            ..envelope.clone()
        };
        assert_eq!(
            at_bob.decrypt(&frame, &wrong_dev, None),
            Err(Undecryptable::SessionMismatch)
        );

        // Bob also holds Alice's next session; the server points the envelope
        // at it.
        let (mut next, _) = OutboundGroup::create(&a1.account, "bob", NOW);
        let mut at_bob_next = share(&a1, &mut b1, &mut next);
        let wrong_sid = Envelope {
            sid: next.session_id(),
            ..envelope.clone()
        };
        assert_eq!(
            at_bob_next.decrypt(&frame, &wrong_sid, None),
            Err(Undecryptable::BadCiphertext)
        );
        assert_eq!(
            at_bob_next.decrypt(&frame, &envelope, None),
            Err(Undecryptable::SessionMismatch)
        );
        assert!(at_bob.decrypt(&frame, &envelope, None).is_ok());
    }

    #[test]
    fn a_redirected_olm_message_is_refused() {
        let mut a1 = Device::new("alice", "AAAAAAAAAAAAAAA1");
        let a2 = Device::new("alice", "AAAAAAAAAAAAAAA2");
        let mut b1 = Device::new("bob", "BBBBBBBBBBBBBBB1");
        let mut b2 = Device::new("bob", "BBBBBBBBBBBBBBB2");
        let (outbound, _) = OutboundGroup::create(&a1.account, "bob", NOW);

        let mut a_to_b = OlmChannel::new(b1.keys());
        a_to_b.start_session(&a1.account, &b1.claim()).unwrap();
        let body = a_to_b
            .encrypt(&a1.account, &ToDevice::RoomKey(outbound.room_key()))
            .unwrap();

        // Handed to Bob's other device.
        assert_eq!(
            OlmChannel::new(a1.keys())
                .decrypt(&mut b2.account, &body)
                .unwrap_err(),
            Undecryptable::BadCiphertext
        );
        // Handed to Bob's device as if from Alice's other device.
        assert_eq!(
            OlmChannel::new(a2.keys())
                .decrypt(&mut b1.account, &body)
                .unwrap_err(),
            Undecryptable::WrongSender
        );
        // Delivered as sent, it opens.
        let mut b_from_a = OlmChannel::new(a1.keys());
        assert!(b_from_a.decrypt(&mut b1.account, &body).is_ok());

        // Once established, a normal message relabelled as another device's.
        let reply = b_from_a
            .encrypt(
                &b1.account,
                &ToDevice::Other {
                    kind: "pong".into(),
                    content: json!({}),
                },
            )
            .unwrap();
        a_to_b.decrypt(&mut a1.account, &reply).unwrap();
        let normal = a_to_b
            .encrypt(
                &a1.account,
                &ToDevice::Other {
                    kind: "ping".into(),
                    content: json!({}),
                },
            )
            .unwrap();
        assert_eq!(normal["type"], 1);
        assert_eq!(
            OlmChannel::new(a2.keys())
                .decrypt(&mut b1.account, &normal)
                .unwrap_err(),
            Undecryptable::BadCiphertext
        );
        assert_eq!(
            b_from_a
                .decrypt(
                    &mut b1.account,
                    &json!({"v": 9, "type": 1, "ct": normal["ct"]})
                )
                .unwrap_err(),
            Undecryptable::Malformed
        );
        assert!(b_from_a.decrypt(&mut b1.account, &normal).is_ok());
    }

    #[test]
    fn an_edit_of_another_accounts_message_is_refused() {
        let Scene {
            a1, b1, mut at_bob, ..
        } = scene();
        let mut alice = a1;

        // Bob writes an "edit" of Alice's m-1 in their conversation.
        let (mut bobs, mut bobs_own) = OutboundGroup::create(&b1.account, "alice", NOW);
        let mut at_alice = share(&b1, &mut alice, &mut bobs);
        let edit = Frame {
            from: "bob",
            to: "alice",
            id: "m-1",
            kind: MessageKind::Edit,
        };
        let envelope = bobs
            .encrypt(&b1.account, &edit, &text("pwned"), None)
            .unwrap();
        assert_eq!(
            at_alice.decrypt(&edit, &envelope, Some("alice")),
            Err(Undecryptable::EditByOtherAccount)
        );
        // Bob editing his own message is fine.
        assert_eq!(
            bobs_own
                .decrypt(&edit, &envelope, Some("bob"))
                .unwrap()
                .content,
            text("pwned")
        );
        // The server cannot pass Bob's edit off as Alice's either.
        let relabelled = Frame {
            from: "alice",
            to: "bob",
            ..edit
        };
        assert_eq!(
            at_bob.decrypt(&relabelled, &envelope, Some("alice")),
            Err(Undecryptable::SessionMismatch)
        );
    }

    #[test]
    fn content_cannot_shadow_what_the_envelope_binds() {
        let Scene {
            a1, mut outbound, ..
        } = scene();
        let mut content = text("hi");
        content.insert("id".into(), json!("m-other"));
        assert_eq!(
            outbound.encrypt(&a1.account, &msg("alice", "bob", "m-2"), &content, None),
            Err(CryptoError::ReservedField { field: "id" })
        );
        assert_eq!(
            outbound.encrypt(&a1.account, &msg("alice", "carol", "m-2"), &text("x"), None),
            Err(CryptoError::WrongSession)
        );
    }

    #[test]
    fn keys_forward_only_between_cross_signed_own_devices_and_upgrade_on_direct_key() {
        let mut a1 = Device::new("alice", "AAAAAAAAAAAAAAA1");
        let mut a2 = Device::new("alice", "AAAAAAAAAAAAAAA2");
        let a_unsigned = Device::new("alice", "AAAAAAAAAAAAAAA3");
        let b1 = Device::new("bob", "BBBBBBBBBBBBBBB1");

        let alice_cross = tailchat_crypto::CrossSigning::new("alice").unwrap();
        let a1_signed = alice_cross.sign_device(&a1.keys()).unwrap();
        let a2_signed = alice_cross.sign_device(&a2.keys()).unwrap();

        // Bob encrypts m-1 to Alice's first device before A2 exists.
        let (mut bob_out, _) = OutboundGroup::create(&b1.account, "alice", NOW);
        let at_a1 = share(&b1, &mut a1, &mut bob_out);
        let m1 = bob_out
            .encrypt(&b1.account, &msg("bob", "alice", "m-1"), &text("old"), None)
            .unwrap();

        // Refused to a foreign device and to an unsigned own device.
        assert_eq!(
            at_a1
                .export_forwarded(&a1.account, alice_cross.public(), &b1.keys())
                .unwrap_err(),
            CryptoError::UntrustedDevice
        );
        assert_eq!(
            at_a1
                .export_forwarded(&a1.account, alice_cross.public(), &a_unsigned.keys())
                .unwrap_err(),
            CryptoError::UntrustedDevice
        );

        // Forwarded from A1 to cross-signed A2 over Olm: A2 reads m-1 with
        // sender_verified = false, then upgrades to true when Bob's direct RoomKey arrives.
        let exported = at_a1
            .export_forwarded(&a1.account, alice_cross.public(), &a2_signed)
            .unwrap();
        let mut a1_to_a2 = OlmChannel::new(a2_signed);
        a1_to_a2.start_session(&a1.account, &a2.claim()).unwrap();
        let body = a1_to_a2
            .encrypt(&a1.account, &ToDevice::ForwardedRoomKey(exported))
            .unwrap();
        let mut a2_from_a1 = OlmChannel::new(a1_signed);
        let Received::ForwardedRoomKey(received) =
            a2_from_a1.decrypt(&mut a2.account, &body).unwrap()
        else {
            panic!("expected ForwardedRoomKey");
        };
        let mut at_a2 =
            InboundGroup::from_forwarded_key(&a2.account, alice_cross.public(), *received).unwrap();
        assert!(!at_a2.is_sender_verified());
        assert_eq!(
            at_a2
                .decrypt(&msg("bob", "alice", "m-1"), &m1, None)
                .unwrap()
                .content,
            text("old")
        );

        let direct = share(&b1, &mut a2, &mut bob_out);
        assert!(direct.is_sender_verified());
        assert!(at_a2.merge(direct));
        assert!(at_a2.is_sender_verified());
        assert_eq!(at_a2.first_known_index(), 0);

        // Sharing cross-signing secret over Olm from A1 to A2.
        let shared_cross = alice_cross.share(&a1.account, a1_to_a2.peer()).unwrap();
        let cross_body = a1_to_a2
            .encrypt(&a1.account, &ToDevice::CrossSigningKey(shared_cross))
            .unwrap();
        let Received::CrossSigningKey(received_cross) =
            a2_from_a1.decrypt(&mut a2.account, &cross_body).unwrap()
        else {
            panic!("expected CrossSigningKey");
        };
        let restored_cross =
            tailchat_crypto::CrossSigning::from_shared(&a2.account, *received_cross).unwrap();
        assert_eq!(restored_cross.master_key(), alice_cross.master_key());
    }

    #[test]
    fn backup_restores_history_and_cross_signing_on_new_device_and_shares_over_olm() {
        let a1 = Device::new("alice", "AAAAAAAAAAAAAAA1");
        let mut a2 = Device::new("alice", "AAAAAAAAAAAAAAA2");
        let a_unsigned = Device::new("alice", "AAAAAAAAAAAAAAA3");
        let b1 = Device::new("bob", "BBBBBBBBBBBBBBB1");

        let alice_cross = a1.account.cross_signing();
        let a1_signed = a1.keys();
        let mut a1_recv = Device::new("alice", "AAAAAAAAAAAAAAA1");

        // Bob sends a message to Alice before A2 exists.
        let (mut bob_out, _) = OutboundGroup::create(&b1.account, "alice", NOW);
        let at_a1 = share(&b1, &mut a1_recv, &mut bob_out);
        let m1 = bob_out
            .encrypt(
                &b1.account,
                &msg("bob", "alice", "m-hist-1"),
                &text("before a2"),
                None,
            )
            .unwrap();

        // A1 creates backup v1 and encrypts its cross-signing secret + inbound session.
        let (backup_a1, recovery) = tailchat_crypto::BackupKey::new("alice", 1).unwrap();
        let enc_cross = backup_a1.encrypt_cross_signing(alice_cross).unwrap();
        let enc_sess = backup_a1.encrypt_session(&at_a1).unwrap();

        // Brand-new device A2 unlocks the backup from the recovery key, signs itself
        // with the recovered self-signing key, and reads Bob's historical message.
        let backup_a2 =
            tailchat_crypto::BackupKey::from_recovery_key("alice", recovery.expose()).unwrap();
        let restored_cross = backup_a2
            .decrypt_cross_signing(&enc_cross, Some(alice_cross.public()))
            .unwrap();
        let a2_signed = restored_cross.sign_device(&a2.keys()).unwrap();
        assert!(alice_cross.verifies(&a2_signed));

        let mut restored_sess = backup_a2
            .decrypt_session(&enc_sess.session_id, &enc_sess.nonce, &enc_sess.ct)
            .unwrap();
        assert!(!restored_sess.is_sender_verified());
        assert_eq!(
            restored_sess
                .decrypt(&msg("bob", "alice", "m-hist-1"), &m1, None)
                .unwrap()
                .content,
            text("before a2")
        );

        // BackupKey::share refuses foreign and unverified devices, and succeeds over Olm
        // between cross-signed own client devices.
        assert_eq!(
            backup_a1
                .share(&a1.account, alice_cross.public(), &b1.keys())
                .unwrap_err(),
            CryptoError::UntrustedDevice
        );
        assert_eq!(
            backup_a1
                .share(&a1.account, alice_cross.public(), &a_unsigned.keys())
                .unwrap_err(),
            CryptoError::UntrustedDevice
        );
        let shared_bk = backup_a1
            .share(&a1.account, alice_cross.public(), &a2_signed)
            .unwrap();
        let mut a1_to_a2 = OlmChannel::new(a2_signed);
        a1_to_a2.start_session(&a1.account, &a2.claim()).unwrap();
        let bk_body = a1_to_a2
            .encrypt(&a1.account, &ToDevice::BackupKey(shared_bk))
            .unwrap();
        let mut a2_from_a1 = OlmChannel::new(a1_signed);
        let Received::BackupKey(received_bk) =
            a2_from_a1.decrypt(&mut a2.account, &bk_body).unwrap()
        else {
            panic!("expected BackupKey");
        };
        let olm_backup = tailchat_crypto::BackupKey::from_shared(
            &a2.account,
            alice_cross.public(),
            *received_bk,
        )
        .unwrap();
        assert_eq!(olm_backup, backup_a1);
        let pickled = olm_backup.pickle().unwrap();
        assert_eq!(
            tailchat_crypto::BackupKey::from_pickle(&pickled).unwrap(),
            backup_a1
        );
    }
}
