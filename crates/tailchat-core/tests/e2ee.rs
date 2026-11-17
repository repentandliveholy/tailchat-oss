//! End-to-end encryption in the core (spec E2EE §6, sub-stage 6c): device
//! registration, key top-up, and that a core with encryption off says
//! nothing new.

mod common;

#[cfg(test)]
mod cases {
    use serde_json::{Value, json};
    use tailchat_core::{
        ApiCall, ApiRequest, Core, Event, FetchError, Input, Login, Output, Refusal, Secret,
        Storage, StoreOp, Token, Ts,
    };
    use tailchat_crypto::DeviceKeys;
    use zeroize::Zeroizing;

    use super::common::MemStore as Store;

    const DEVICE: &str = "AAAAAAAAAAAAAAAA";
    const READY_E2EE: &str = r#"{"k":"ready","users":[{"login":"bob"}],"caps":["e2ee-v1"]}"#;
    const READY_PLAIN: &str = r#"{"k":"ready","users":[{"login":"bob"}],"caps":[]}"#;

    /// What the core asked for, in order.
    #[derive(Debug)]
    enum Step {
        Send(Value),
        Persist(Vec<StoreOp>),
        Event(Event),
        Post(ApiRequest),
    }

    struct Client {
        core: Core,
        store: Store,
        steps: Vec<Step>,
    }

    impl Client {
        fn new(e2ee: bool) -> Self {
            Self::restore(Store::default(), e2ee)
        }
        fn restore(store: Store, e2ee: bool) -> Self {
            let mut core = Core::new(
                Login::parse("alice").unwrap(),
                Token::parse(&"a".repeat(64)).unwrap(),
                store.load().unwrap(),
            );
            core.set_e2ee(e2ee);
            Self {
                core,
                store,
                steps: Vec::new(),
            }
        }
        fn step(&mut self, now: i64, input: Input) {
            for output in self.core.handle(Ts(now), input).unwrap() {
                match output {
                    Output::Send(frame) => {
                        self.steps
                            .push(Step::Send(serde_json::from_str(&frame).unwrap()));
                    }
                    Output::Persist(ops) => {
                        self.store.apply(&ops).unwrap();
                        self.steps.push(Step::Persist(ops));
                    }
                    Output::Event(event) => self.steps.push(Step::Event(event)),
                    Output::Post(request) => self.steps.push(Step::Post(request)),
                    Output::Fetch(_) => {}
                }
            }
        }
        fn connect(&mut self, now: i64, ready: &str) {
            self.step(now, Input::Connected);
            self.step(now, Input::Frame(ready.into()));
        }
        fn posts(&self) -> Vec<&ApiRequest> {
            self.steps
                .iter()
                .filter_map(|s| match s {
                    Step::Post(r) => Some(r),
                    _ => None,
                })
                .collect()
        }
        fn last_post(&self) -> ApiRequest {
            (*self.posts().last().expect("a post")).clone()
        }
        fn events(&self) -> Vec<&Event> {
            self.steps
                .iter()
                .filter_map(|s| match s {
                    Step::Event(e) => Some(e),
                    _ => None,
                })
                .collect()
        }
        fn answer(&mut self, now: i64, request: ApiRequest, body: Value) {
            self.step(
                now,
                Input::Posted {
                    request,
                    body: body.to_string(),
                },
            );
        }
        /// The server's answer to an upload: it keeps what came, up to 50.
        fn server_answer(request: &ApiRequest, held: usize) -> Value {
            let body: Value = serde_json::from_str(&request.body).unwrap();
            let fresh = body["oneTimeKeys"].as_object().map_or(0, |o| o.len());
            json!({
                "deviceId": DEVICE,
                "registered": body.get("deviceKeys").is_some(),
                "oneTimeKeyCount": (held + fresh).min(50),
                "fallbackKey": true,
            })
        }
    }

    fn auth_caps(client: &Client) -> Vec<String> {
        let Some(Step::Send(auth)) = client.steps.first() else {
            panic!("auth first: {:?}", client.steps);
        };
        auth["caps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c.as_str().unwrap().to_owned())
            .collect()
    }

    /// Registers a fresh device all the way; returns the client.
    fn registered() -> Client {
        let mut client = Client::new(true);
        client.connect(1, READY_E2EE);
        let first = client.last_post();
        client.answer(2, first, json!({"deviceId": DEVICE}));
        let upload = client.last_post();
        let answer = Client::server_answer(&upload, 0);
        client.answer(3, upload, answer);
        client
    }

    #[test]
    fn a_core_with_encryption_off_claims_nothing_and_posts_nothing() {
        let mut client = Client::new(false);
        client.connect(1, READY_E2EE);
        assert!(!auth_caps(&client).contains(&"e2ee-v1".to_owned()));
        assert!(client.posts().is_empty());
        assert!(client.core.next_wakeup().is_none());
        assert!(client.store.snapshot.crypto_account.is_none());
    }

    #[test]
    fn a_server_without_the_capability_gets_no_key_request() {
        let mut client = Client::new(true);
        client.connect(1, READY_PLAIN);
        assert!(auth_caps(&client).contains(&"e2ee-v1".to_owned()));
        assert!(client.posts().is_empty());
    }

    #[test]
    fn registration_stores_the_account_before_publishing_its_keys() {
        let mut client = Client::new(true);
        client.connect(1, READY_E2EE);
        let first = client.last_post();
        assert_eq!(first.call, ApiCall::KeysUpload);
        assert_eq!(first.body, "{}", "the first call only asks for a device id");

        client.steps.clear();
        client.answer(2, first, json!({"deviceId": DEVICE}));
        // The account is on disk before the request that publishes its keys.
        let persisted = client
            .steps
            .iter()
            .position(|s| matches!(s, Step::Persist(ops) if matches!(ops[..], [StoreOp::PutCryptoAccount(_)])))
            .expect("the account is persisted");
        let posted = client
            .steps
            .iter()
            .position(|s| matches!(s, Step::Post(_)))
            .expect("the keys are posted");
        assert!(persisted < posted, "{:?}", client.steps);

        let upload = client.last_post();
        let body: Value = serde_json::from_str(&upload.body).unwrap();
        let device = DeviceKeys::from_json(&body["deviceKeys"]).unwrap();
        assert_eq!(device.login(), "alice");
        assert_eq!(device.device_id(), DEVICE);
        // Their signatures are `tailchat-crypto`'s to check (`upload_body`).
        assert_eq!(body["oneTimeKeys"].as_object().unwrap().len(), 50);

        client.steps.clear();
        let answer = Client::server_answer(&upload, 0);
        client.answer(3, upload, answer);
        assert!(
            client
                .events()
                .iter()
                .any(|e| matches!(e, Event::DeviceRegistered { device_id } if device_id == DEVICE))
        );
        // Nothing more to publish; what follows only reads this account's own
        // keys — its devices and whom it vouches for on the others.
        let posts = client.posts();
        assert_eq!(posts.len(), 1, "{posts:?}");
        assert_eq!(posts[0].call, ApiCall::KeysQuery);
        assert_eq!(posts[0].body, r#"{"logins":["alice"]}"#);
        assert_eq!(client.core.device_id(), Some(DEVICE));
    }

    #[test]
    fn a_restart_keeps_the_device_and_republishes_no_keys() {
        let client = registered();
        let identity = DeviceKeys::from_json(
            &serde_json::from_str::<Value>(&client.posts()[1].body).unwrap()["deviceKeys"],
        )
        .unwrap();

        let mut again = Client::restore(client.store.clone(), true);
        again.connect(10, READY_E2EE);
        let upload = again.last_post();
        let body: Value = serde_json::from_str(&upload.body).unwrap();
        assert_eq!(
            DeviceKeys::from_json(&body["deviceKeys"]).unwrap(),
            identity
        );
        assert!(body["oneTimeKeys"].as_object().unwrap().is_empty());
        assert!(body.get("fallbackKey").is_none());
        again.answer(
            11,
            upload,
            json!({"deviceId": DEVICE, "registered": true,
            "oneTimeKeyCount": 50, "fallbackKey": true}),
        );
        let posts = again.posts();
        assert_eq!(posts.len(), 2, "the keys once, then only reading its own");
        assert_eq!(posts[1].call, ApiCall::KeysQuery);
        assert!(
            again
                .events()
                .iter()
                .any(|e| matches!(e, Event::DeviceRegistered { .. }))
        );
    }

    #[test]
    fn keys_whose_answer_was_lost_go_again_unchanged() {
        let mut client = Client::new(true);
        client.connect(1, READY_E2EE);
        let first = client.last_post();
        client.answer(2, first, json!({"deviceId": DEVICE}));
        let lost = client.last_post();
        // The process dies before the server's answer is read.
        let mut again = Client::restore(client.store.clone(), true);
        again.connect(10, READY_E2EE);
        let resent = again.last_post();
        let keys =
            |r: &ApiRequest| serde_json::from_str::<Value>(&r.body).unwrap()["oneTimeKeys"].clone();
        assert_eq!(
            keys(&resent),
            keys(&lost),
            "the same keys, so the server dedups them"
        );
    }

    #[test]
    fn the_device_tops_up_one_time_keys_the_server_ran_low_on() {
        let mut client = registered();
        client.steps.clear();
        client.connect(20, READY_E2EE);
        let upload = client.last_post();
        client.steps.clear();
        client.answer(
            21,
            upload,
            json!({"deviceId": DEVICE, "registered": true,
            "oneTimeKeyCount": 10, "fallbackKey": false}),
        );
        let Some(Step::Persist(_)) = client.steps.first() else {
            panic!("persist before the new keys go: {:?}", client.steps);
        };
        let top_up = client.last_post();
        let body: Value = serde_json::from_str(&top_up.body).unwrap();
        assert_eq!(body["oneTimeKeys"].as_object().unwrap().len(), 40);
        assert_eq!(body["fallbackKey"].as_object().unwrap().len(), 1);
        assert!(
            !client
                .events()
                .iter()
                .any(|e| matches!(e, Event::DeviceRegistered { .. }))
        );
        let answer = Client::server_answer(&top_up, 10);
        client.answer(22, top_up, answer);
        assert!(
            client
                .events()
                .iter()
                .any(|e| matches!(e, Event::DeviceRegistered { .. }))
        );
    }

    #[test]
    fn a_refused_upload_stops_encryption_and_says_so_once() {
        let mut client = Client::new(true);
        client.connect(1, READY_E2EE);
        let first = client.last_post();
        client.answer(2, first, json!({"deviceId": DEVICE}));
        let upload = client.last_post();
        client.step(
            3,
            Input::PostFailed {
                request: upload,
                error: FetchError::Status(409, None),
            },
        );
        let failures = |c: &Client| {
            c.events()
                .iter()
                .filter(|e| matches!(e, Event::EncryptionFailed { .. }))
                .count()
        };
        assert_eq!(failures(&client), 1);
        let posted = client.posts().len();
        client.connect(4, READY_E2EE);
        assert_eq!(client.posts().len(), posted, "no more key requests");
        assert_eq!(failures(&client), 1, "told once");
    }

    #[test]
    fn keys_already_published_under_this_device_id_ask_for_a_new_sign_in_not_a_retry() {
        let mut client = Client::new(true);
        client.connect(1, READY_E2EE);
        let first = client.last_post();
        client.answer(2, first, json!({"deviceId": DEVICE}));
        let upload = client.last_post();
        client.step(
            3,
            Input::PostFailed {
                request: upload,
                error: FetchError::Status(409, Some(Refusal::DeviceKeysChanged)),
            },
        );
        let count = |c: &Client, conflict: bool| {
            c.events()
                .iter()
                .filter(|e| {
                    if conflict {
                        matches!(e, Event::DeviceKeysConflict)
                    } else {
                        matches!(e, Event::EncryptionFailed { .. })
                    }
                })
                .count()
        };
        assert_eq!(
            count(&client, true),
            1,
            "the person is told to sign in again"
        );
        assert_eq!(
            count(&client, false),
            0,
            "instead of a bare 'upload refused', never with it"
        );
        let posted = client.posts().len();
        client.connect(4, READY_E2EE);
        assert_eq!(
            client.posts().len(),
            posted,
            "asking again cannot help, so nothing is asked"
        );
        assert_eq!(count(&client, true), 1, "told once, not on every reconnect");
    }

    #[test]
    fn a_network_failure_retries_after_a_pause_and_a_stale_answer_is_ignored() {
        let mut client = Client::new(true);
        client.connect(1, READY_E2EE);
        let first = client.last_post();
        client.step(
            2,
            Input::PostFailed {
                request: first.clone(),
                error: FetchError::Network,
            },
        );
        assert_eq!(client.core.next_wakeup(), Some(Ts(5_002)));
        client.step(3_000, Input::Tick);
        assert_eq!(client.posts().len(), 1, "not before the pause");
        client.step(5_002, Input::Tick);
        assert_eq!(client.posts().len(), 2);
        // An answer to the abandoned first request changes nothing.
        client.answer(5_003, first, json!({"deviceId": "BBBBBBBBBBBBBBBB"}));
        assert!(client.store.snapshot.crypto_account.is_none());
        let retry = client.last_post();
        client.answer(5_004, retry, json!({"deviceId": DEVICE}));
        assert_eq!(client.core.device_id(), Some(DEVICE));
    }

    #[test]
    fn a_server_that_moves_the_session_to_another_device_stops_encryption() {
        let mut client = registered();
        client.connect(30, READY_E2EE);
        let upload = client.last_post();
        client.answer(
            31,
            upload,
            json!({"deviceId": "BBBBBBBBBBBBBBBB", "registered": true,
            "oneTimeKeyCount": 50, "fallbackKey": true}),
        );
        assert!(
            client
                .events()
                .iter()
                .any(|e| matches!(e, Event::EncryptionFailed { .. }))
        );
        assert_eq!(
            client.core.device_id(),
            Some(DEVICE),
            "the device keeps its own id"
        );
    }

    #[test]
    fn unreadable_stored_keys_stop_encryption_not_the_core() {
        let mut store = Store::default();
        store.snapshot.crypto_account = Some(Secret::new(Zeroizing::new("{}".to_owned())));
        let mut client = Client::restore(store, true);
        client.connect(1, READY_E2EE);
        assert!(client.posts().is_empty());
        assert!(
            client
                .events()
                .iter()
                .any(|e| matches!(e, Event::EncryptionFailed { .. }))
        );
        assert!(client.core.is_ready());
    }

    #[test]
    fn secrets_never_print() {
        let client = registered();
        let account = client.store.snapshot.crypto_account.clone().unwrap();
        let op = StoreOp::PutCryptoAccount(account.clone());
        let printed = format!("{op:?}");
        assert_eq!(printed, "PutCryptoAccount([redacted])");
        assert!(!printed.contains(&account.expose()[..20]));
    }

    #[test]
    fn to_device_waits_for_registration_and_failed_query_pause_clears_on_tick() {
        let prev = registered();
        let mut client = Client::restore(prev.store.clone(), true);
        client.connect(10, READY_E2EE);
        let upload = client.last_post();
        assert_eq!(upload.call, ApiCall::KeysUpload);
        client.steps.clear();

        // A to-device arrives before KeysUpload has completed: no query or ack yet.
        client.step(
            11,
            Input::Frame(
                json!({
                    "k": "to-device",
                    "seq": 7,
                    "from": "bob",
                    "fromDevice": "BBBBBBBBBBBBBBBB",
                    "body": {"v": 1, "type": 0, "ct": "AA"}
                })
                .to_string(),
            ),
        );
        assert!(
            client.posts().is_empty(),
            "must not query before upload completes"
        );

        // Registration completes: now the queued to-device triggers KeysQuery.
        client.answer(
            12,
            upload,
            json!({"deviceId": DEVICE, "registered": true, "oneTimeKeyCount": 50, "fallbackKey": true}),
        );
        let query = client.last_post();
        assert_eq!(query.call, ApiCall::KeysQuery);

        // KeysQuery fails: wakeup is armed for 13 + 5_000 = 5_013, and a tick at
        // 5_013 retries KeysQuery and clears the pause so wakeup is None while in flight.
        client.step(
            13,
            Input::PostFailed {
                request: query,
                error: FetchError::Network,
            },
        );
        assert_eq!(client.core.next_wakeup(), Some(Ts(5_013)));
        client.step(5_013, Input::Tick);
        assert_eq!(client.last_post().call, ApiCall::KeysQuery);
        assert_eq!(client.core.next_wakeup(), None);
    }
}
