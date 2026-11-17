//! Short Authentication String (SAS) verification (`docs/specs/2026-11-04-e2ee.md`
//! §4.2): commitment-protected ephemeral Curve25519 key agreement (`vodozemac::sas`)
//! followed by 7-emoji / 3-number comparison and HMAC-SHA256 over both master
//! keys and both device keys.
//!
//! Why commitment is mandatory (§11 finding #8): if the responder saw the
//! initiator's ephemeral public key before committing to its own, a man-in-the-
//! middle could grind its ephemeral key until the 42-bit emoji string matched.
//! The protocol therefore requires:
//! 1. Initiator → Responder: `Start { transaction_id }`
//! 2. Responder → Initiator: `Accept { transaction_id, commitment }` (SHA-256 over
//!    the responder's ephemeral key before the initiator's key is sent)
//! 3. Initiator → Responder: `Key { transaction_id, key: initiator_pub }`
//! 4. Responder → Initiator: `Key { transaction_id, key: responder_pub }` (checked
//!    against `commitment` before Diffie-Hellman)
//! 5. Both sides (after human confirmation): `Mac { transaction_id, master_key, mac }`
//!    computed with `EstablishedSas::calculate_mac` / `verify_mac` (never
//!    `calculate_mac_invalid_base64`).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vodozemac::base64_encode;
use vodozemac::sas::{EstablishedSas, Mac, Sas};

use crate::device::parse_curve;
use crate::{CryptoError, DeviceKeys, Undecryptable};

/// The 64 standard Matrix SAS emojis, indexed 0..64 (`SasBytes::emoji_indices`).
pub const SAS_EMOJIS: [(&str, &str); 64] = [
    ("🐶", "dog"),
    ("🐱", "cat"),
    ("🦁", "lion"),
    ("🐎", "horse"),
    ("🦄", "unicorn"),
    ("🐷", "pig"),
    ("🐘", "elephant"),
    ("🐰", "rabbit"),
    ("🐼", "panda"),
    ("🐓", "rooster"),
    ("🐧", "penguin"),
    ("🐢", "turtle"),
    ("🐟", "fish"),
    ("🐙", "octopus"),
    ("🦋", "butterfly"),
    ("🌷", "flower"),
    ("🌳", "tree"),
    ("🌵", "cactus"),
    ("🍄", "mushroom"),
    ("🌏", "globe"),
    ("🌙", "moon"),
    ("☁️", "cloud"),
    ("🔥", "fire"),
    ("🍌", "banana"),
    ("🍎", "apple"),
    ("🍓", "strawberry"),
    ("🌽", "corn"),
    ("🍕", "pizza"),
    ("🎂", "cake"),
    ("🍬", "candy"),
    ("🍺", "beer"),
    ("☕", "coffee"),
    ("⚽", "ball"),
    ("🏆", "trophy"),
    ("🎸", "guitar"),
    ("🎺", "trumpet"),
    ("🔔", "bell"),
    ("⚓", "anchor"),
    ("🎧", "headphones"),
    ("📁", "folder"),
    ("📌", "pin"),
    ("🔑", "key"),
    ("🔒", "lock"),
    ("💡", "bulb"),
    ("🔨", "hammer"),
    ("☎️", "telephone"),
    ("🚩", "flag"),
    ("🚂", "train"),
    ("🚲", "bicycle"),
    ("✈️", "aeroplane"),
    ("🚀", "rocket"),
    ("👑", "crown"),
    ("✂️", "scissors"),
    ("📘", "book"),
    ("✏️", "pencil"),
    ("📎", "paperclip"),
    ("❤️", "heart"),
    ("💎", "diamond"),
    ("👍", "thumbs_up"),
    ("☂️", "umbrella"),
    ("⏳", "hourglass"),
    ("⏰", "clock"),
    ("🎁", "gift"),
    ("🕶️", "glasses"),
];

/// Wire steps carried inside `ToDevice::Sas` over an Olm channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum SasMessage {
    /// Step 1 (Initiator → Responder): begin a SAS verification.
    Start {
        /// Unique id for this verification handshake.
        #[serde(rename = "transactionId")]
        transaction_id: String,
    },
    /// Step 2 (Responder → Initiator): SHA-256 commitment to the responder's
    /// ephemeral public key, sent before the initiator's key is revealed.
    Accept {
        /// Handshake id.
        #[serde(rename = "transactionId")]
        transaction_id: String,
        /// Unpadded base64 of SHA-256 commitment (43 chars).
        commitment: String,
    },
    /// Step 3 (Initiator → Responder) and Step 4 (Responder → Initiator):
    /// ephemeral Curve25519 public key (unpadded base64).
    Key {
        /// Handshake id.
        #[serde(rename = "transactionId")]
        transaction_id: String,
        /// Ephemeral Curve25519 public key, unpadded base64.
        key: String,
    },
    /// Step 5 (both sides after user confirms the emojis/numbers): HMAC-SHA256
    /// over both master keys and both device keys.
    Mac {
        /// Handshake id.
        #[serde(rename = "transactionId")]
        transaction_id: String,
        /// The sender's master Ed25519 public key (unpadded base64).
        #[serde(rename = "masterKey")]
        master_key: String,
        /// Unpadded base64 HMAC-SHA256 tag from `EstablishedSas::calculate_mac`.
        mac: String,
    },
    /// Abort the handshake.
    Cancel {
        /// Handshake id.
        #[serde(rename = "transactionId")]
        transaction_id: String,
        /// Machine reason code.
        reason: String,
    },
}

impl SasMessage {
    /// The handshake id this message belongs to.
    pub fn transaction_id(&self) -> &str {
        match self {
            Self::Start { transaction_id }
            | Self::Accept { transaction_id, .. }
            | Self::Key { transaction_id, .. }
            | Self::Mac { transaction_id, .. }
            | Self::Cancel { transaction_id, .. } => transaction_id,
        }
    }
}

/// The short authentication string both users compare on screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SasCode {
    /// Seven 6-bit indices (0..64) into [`SAS_EMOJIS`].
    pub emoji_indices: [u8; 7],
    /// Three 13-bit decimal numbers (1000..=9191).
    pub decimals: [u16; 3],
}

impl SasCode {
    /// The seven `(emoji, label)` pairs from [`SAS_EMOJIS`].
    pub fn emojis(&self) -> [(&'static str, &'static str); 7] {
        self.emoji_indices.map(|idx| {
            SAS_EMOJIS
                .get(usize::from(idx))
                .copied()
                .unwrap_or(("🔒", "lock"))
        })
    }
}

/// Proof that both sides confirmed the same SAS code and verified each other's
/// MAC over both master keys and both device keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SasVerified {
    /// Handshake id.
    pub transaction_id: String,
    /// The verified peer device.
    pub peer_device: DeviceKeys,
    /// The verified master key of the peer account.
    pub peer_master_key: String,
}

enum Phase {
    InitiatorWaitingAccept {
        sas: Sas,
    },
    InitiatorWaitingKey {
        sas: Sas,
        commitment: String,
    },
    ResponderWaitingKey {
        sas: Sas,
    },
    Established {
        sas: EstablishedSas,
        code: SasCode,
        our_confirmed_master: Option<String>,
        their_mac: Option<(String, String)>,
    },
    Done,
}

/// One in-flight SAS verification handshake with one peer device.
pub struct SasSession {
    transaction_id: String,
    own_device: DeviceKeys,
    peer_device: DeviceKeys,
    we_started: bool,
    phase: Phase,
}

impl std::fmt::Debug for SasSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SasSession")
            .field("transaction_id", &self.transaction_id)
            .field("own_device", &self.own_device)
            .field("peer_device", &self.peer_device)
            .field("we_started", &self.we_started)
            .finish_non_exhaustive()
    }
}

impl SasSession {
    /// Start a SAS verification as initiator (`own_device` → `peer_device`).
    /// Returns the session and the `Start` message to send over Olm.
    pub fn start(
        transaction_id: String,
        own_device: DeviceKeys,
        peer_device: DeviceKeys,
    ) -> (Self, SasMessage) {
        let sas = Sas::new();
        let message = SasMessage::Start {
            transaction_id: transaction_id.clone(),
        };
        (
            Self {
                transaction_id,
                own_device,
                peer_device,
                we_started: true,
                phase: Phase::InitiatorWaitingAccept { sas },
            },
            message,
        )
    }

    /// Accept a `Start` message as responder (`own_device` answering `peer_device`).
    /// Commits to our ephemeral public key before seeing the initiator's key.
    pub fn accept(
        transaction_id: String,
        own_device: DeviceKeys,
        peer_device: DeviceKeys,
    ) -> (Self, SasMessage) {
        let sas = Sas::new();
        let responder_pub = sas.public_key().to_base64();
        let commitment =
            compute_commitment(&transaction_id, &peer_device, &own_device, &responder_pub);
        let message = SasMessage::Accept {
            transaction_id: transaction_id.clone(),
            commitment,
        };
        (
            Self {
                transaction_id,
                own_device,
                peer_device,
                we_started: false,
                phase: Phase::ResponderWaitingKey { sas },
            },
            message,
        )
    }

    /// The handshake id.
    pub fn transaction_id(&self) -> &str {
        &self.transaction_id
    }

    /// The peer device being verified.
    pub fn peer_device(&self) -> &DeviceKeys {
        &self.peer_device
    }

    /// The SAS code, once both ephemeral keys have been exchanged.
    pub fn code(&self) -> Option<&SasCode> {
        match &self.phase {
            Phase::Established { code, .. } => Some(code),
            _ => None,
        }
    }

    /// Initiator: handle the responder's `Accept` commitment and return our
    /// `Key` message.
    ///
    /// # Errors
    /// [`Undecryptable::SasWithoutCommitment`] if not waiting for `Accept` or
    /// if the commitment is malformed.
    pub fn on_accept(&mut self, commitment: &str) -> Result<SasMessage, Undecryptable> {
        if commitment.len() != 43
            || !commitment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
        {
            return Err(Undecryptable::SasWithoutCommitment);
        }
        let prev = std::mem::replace(&mut self.phase, Phase::Done);
        let Phase::InitiatorWaitingAccept { sas } = prev else {
            return Err(Undecryptable::SasWithoutCommitment);
        };
        let key = sas.public_key().to_base64();
        self.phase = Phase::InitiatorWaitingKey {
            sas,
            commitment: commitment.to_owned(),
        };
        Ok(SasMessage::Key {
            transaction_id: self.transaction_id.clone(),
            key,
        })
    }

    /// Handle the peer's `Key` message.
    /// - For the responder: computes the shared secret and returns `(SasCode,
    ///   Some(SasMessage::Key))` to send back.
    /// - For the initiator: checks the responder's key against the earlier
    ///   `Accept` commitment (refusing with [`Undecryptable::SasWithoutCommitment`]
    ///   if no commitment arrived or [`Undecryptable::SasCommitmentMismatch`]
    ///   if it does not match), computes the shared secret and returns
    ///   `(SasCode, None)`.
    ///
    /// # Errors
    /// [`Undecryptable`] on missing/mismatched commitment, bad key or non-contributory DH.
    pub fn on_key(
        &mut self,
        their_key_b64: &str,
    ) -> Result<(SasCode, Option<SasMessage>), Undecryptable> {
        let their_key = parse_curve(their_key_b64).map_err(|_| Undecryptable::Malformed)?;
        let prev = std::mem::replace(&mut self.phase, Phase::Done);
        match prev {
            Phase::InitiatorWaitingAccept { .. } => Err(Undecryptable::SasWithoutCommitment),
            Phase::InitiatorWaitingKey { sas, commitment } => {
                let expected = compute_commitment(
                    &self.transaction_id,
                    &self.own_device,
                    &self.peer_device,
                    their_key_b64,
                );
                if commitment != expected {
                    return Err(Undecryptable::SasCommitmentMismatch);
                }
                let initiator_pub = sas.public_key().to_base64();
                let responder_pub = their_key_b64.to_owned();
                let established = sas
                    .diffie_hellman(their_key)
                    .map_err(|_| Undecryptable::BadCiphertext)?;
                let code = derive_code(
                    &established,
                    &self.transaction_id,
                    &self.own_device,
                    &initiator_pub,
                    &self.peer_device,
                    &responder_pub,
                );
                self.phase = Phase::Established {
                    sas: established,
                    code: code.clone(),
                    our_confirmed_master: None,
                    their_mac: None,
                };
                Ok((code, None))
            }
            Phase::ResponderWaitingKey { sas } => {
                let initiator_pub = their_key_b64.to_owned();
                let responder_pub = sas.public_key().to_base64();
                let established = sas
                    .diffie_hellman(their_key)
                    .map_err(|_| Undecryptable::BadCiphertext)?;
                let code = derive_code(
                    &established,
                    &self.transaction_id,
                    &self.peer_device,
                    &initiator_pub,
                    &self.own_device,
                    &responder_pub,
                );
                let reply = SasMessage::Key {
                    transaction_id: self.transaction_id.clone(),
                    key: responder_pub.clone(),
                };
                self.phase = Phase::Established {
                    sas: established,
                    code: code.clone(),
                    our_confirmed_master: None,
                    their_mac: None,
                };
                Ok((code, Some(reply)))
            }
            _ => Err(Undecryptable::SasWithoutCommitment),
        }
    }

    /// The human confirmed that the emojis/decimals match: compute our MAC over
    /// both master keys and both device keys (`EstablishedSas::calculate_mac`).
    /// If the peer's MAC already arrived and verifies, also returns `Some(SasVerified)`.
    ///
    /// # Errors
    /// [`CryptoError::SasState`] if the session is not in the `Established` state.
    pub fn confirm(
        &mut self,
        own_master_key: &str,
        expected_peer_master_key: &str,
    ) -> Result<(SasMessage, Option<SasVerified>), CryptoError> {
        let Phase::Established {
            sas,
            our_confirmed_master,
            their_mac,
            ..
        } = &mut self.phase
        else {
            return Err(CryptoError::SasState);
        };
        let (initiator_dev, initiator_master, responder_dev, responder_master) = if self.we_started
        {
            (
                &self.own_device,
                own_master_key,
                &self.peer_device,
                expected_peer_master_key,
            )
        } else {
            (
                &self.peer_device,
                expected_peer_master_key,
                &self.own_device,
                own_master_key,
            )
        };
        let input = mac_input(
            initiator_dev,
            initiator_master,
            responder_dev,
            responder_master,
        );
        let info = mac_info(&self.own_device, &self.peer_device, &self.transaction_id);
        let mac = sas.calculate_mac(&input, &info).to_base64();
        *our_confirmed_master = Some(own_master_key.to_owned());
        let msg = SasMessage::Mac {
            transaction_id: self.transaction_id.clone(),
            master_key: own_master_key.to_owned(),
            mac,
        };
        let verified = if let Some((peer_master, peer_mac)) = their_mac.clone() {
            match self.check_peer_mac(own_master_key, &peer_master, &peer_mac) {
                Ok(v) => Some(v),
                Err(_) => {
                    self.phase = Phase::Done;
                    return Err(CryptoError::SasState);
                }
            }
        } else {
            None
        };
        Ok((msg, verified))
    }

    /// Handle the peer's `Mac` message. If we already called [`SasSession::confirm`],
    /// verifies the MAC immediately and returns `Some(SasVerified)`; otherwise
    /// stores it until [`SasSession::confirm`] is called.
    ///
    /// # Errors
    /// [`Undecryptable::SasMacInvalid`] if the MAC does not verify or names a
    /// different master key than `expected_peer_master_key`.
    pub fn on_mac(
        &mut self,
        peer_master_key: &str,
        mac_b64: &str,
        expected_peer_master_key: &str,
    ) -> Result<Option<SasVerified>, Undecryptable> {
        if peer_master_key != expected_peer_master_key {
            self.phase = Phase::Done;
            return Err(Undecryptable::SasMacInvalid);
        }
        let Phase::Established {
            our_confirmed_master,
            their_mac,
            ..
        } = &mut self.phase
        else {
            return Err(Undecryptable::SasWithoutCommitment);
        };
        if let Some(own_master) = our_confirmed_master.clone() {
            self.check_peer_mac(&own_master, peer_master_key, mac_b64)
                .map(Some)
        } else {
            *their_mac = Some((peer_master_key.to_owned(), mac_b64.to_owned()));
            Ok(None)
        }
    }

    fn check_peer_mac(
        &mut self,
        own_master_key: &str,
        peer_master_key: &str,
        mac_b64: &str,
    ) -> Result<SasVerified, Undecryptable> {
        let Phase::Established { sas, .. } = &self.phase else {
            return Err(Undecryptable::SasWithoutCommitment);
        };
        let tag = Mac::from_base64(mac_b64).map_err(|_| Undecryptable::SasMacInvalid)?;
        let (initiator_dev, initiator_master, responder_dev, responder_master) = if self.we_started
        {
            (
                &self.own_device,
                own_master_key,
                &self.peer_device,
                peer_master_key,
            )
        } else {
            (
                &self.peer_device,
                peer_master_key,
                &self.own_device,
                own_master_key,
            )
        };
        let input = mac_input(
            initiator_dev,
            initiator_master,
            responder_dev,
            responder_master,
        );
        let info = mac_info(&self.peer_device, &self.own_device, &self.transaction_id);
        sas.verify_mac(&input, &info, &tag)
            .map_err(|_| Undecryptable::SasMacInvalid)?;
        self.phase = Phase::Done;
        Ok(SasVerified {
            transaction_id: self.transaction_id.clone(),
            peer_device: self.peer_device.clone(),
            peer_master_key: peer_master_key.to_owned(),
        })
    }
}

fn compute_commitment(
    transaction_id: &str,
    initiator: &DeviceKeys,
    responder: &DeviceKeys,
    responder_pub_b64: &str,
) -> String {
    let text = format!(
        "TAILCHAT_SAS_COMMIT_V1|{transaction_id}|{}|{}|{}|{}|{responder_pub_b64}",
        initiator.login(),
        initiator.device_id(),
        responder.login(),
        responder.device_id(),
    );
    let digest = Sha256::digest(text.as_bytes());
    base64_encode(digest)
}

fn derive_code(
    sas: &EstablishedSas,
    transaction_id: &str,
    initiator: &DeviceKeys,
    initiator_pub: &str,
    responder: &DeviceKeys,
    responder_pub: &str,
) -> SasCode {
    let info = format!(
        "TAILCHAT_SAS_V1|{}|{}|{initiator_pub}|{}|{}|{responder_pub}|{transaction_id}",
        initiator.login(),
        initiator.device_id(),
        responder.login(),
        responder.device_id(),
    );
    let bytes = sas.bytes(&info);
    let (d0, d1, d2) = bytes.decimals();
    SasCode {
        emoji_indices: bytes.emoji_indices(),
        decimals: [d0, d1, d2],
    }
}

/// Binds both master keys and both devices' identity keys (Ed25519 + Curve25519).
fn mac_input(
    initiator: &DeviceKeys,
    initiator_master: &str,
    responder: &DeviceKeys,
    responder_master: &str,
) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        initiator.login(),
        initiator.device_id(),
        initiator.ed25519(),
        initiator.curve25519(),
        initiator_master,
        responder.login(),
        responder.device_id(),
        responder.ed25519(),
        responder.curve25519(),
        responder_master,
    )
}

/// Binds both logins and both `deviceId`s in sender → recipient direction.
fn mac_info(sender: &DeviceKeys, recipient: &DeviceKeys, transaction_id: &str) -> String {
    format!(
        "TAILCHAT_SAS_MAC_V1|{}|{}|{}|{}|{transaction_id}",
        sender.login(),
        sender.device_id(),
        recipient.login(),
        recipient.device_id(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Account, CrossSigning, DeviceKind};

    fn pair() -> (DeviceKeys, String, DeviceKeys, String) {
        let alice_acc = Account::new("alice", "AAAAAAAAAAAAAAA1", DeviceKind::Client).unwrap();
        let bob_acc = Account::new("bob", "BBBBBBBBBBBBBBB1", DeviceKind::Client).unwrap();
        let alice_cross = CrossSigning::new("alice").unwrap();
        let bob_cross = CrossSigning::new("bob").unwrap();
        (
            alice_acc.identity(),
            alice_cross.master_key(),
            bob_acc.identity(),
            bob_cross.master_key(),
        )
    }

    #[test]
    fn sas_agrees_on_emojis_and_decimals_and_verifies_master_and_device_keys() {
        let (alice_dev, alice_master, bob_dev, bob_master) = pair();
        let (mut alice, start) =
            SasSession::start("tx-1".into(), alice_dev.clone(), bob_dev.clone());
        assert_eq!(start.transaction_id(), "tx-1");

        let (mut bob, accept) =
            SasSession::accept("tx-1".into(), bob_dev.clone(), alice_dev.clone());
        let SasMessage::Accept { commitment, .. } = &accept else {
            panic!("expected Accept");
        };

        let alice_key_msg = alice.on_accept(commitment).unwrap();
        let SasMessage::Key { key: alice_key, .. } = &alice_key_msg else {
            panic!("expected Key");
        };

        let (bob_code, Some(bob_key_msg)) = bob.on_key(alice_key).unwrap() else {
            panic!("expected responder key");
        };
        let SasMessage::Key { key: bob_key, .. } = &bob_key_msg else {
            panic!("expected Key");
        };

        let (alice_code, None) = alice.on_key(bob_key).unwrap() else {
            panic!("initiator sends no second key");
        };
        assert_eq!(alice_code, bob_code);
        assert_eq!(alice_code.emojis().len(), 7);

        let (alice_mac_msg, None) = alice.confirm(&alice_master, &bob_master).unwrap() else {
            panic!("waiting for bob's mac");
        };
        let SasMessage::Mac {
            master_key: a_m,
            mac: a_mac,
            ..
        } = &alice_mac_msg
        else {
            panic!("expected Mac");
        };

        // Bob receives Alice's MAC first, then confirms.
        assert!(bob.on_mac(a_m, a_mac, &alice_master).unwrap().is_none());
        let (bob_mac_msg, Some(bob_verified)) = bob.confirm(&bob_master, &alice_master).unwrap()
        else {
            panic!("bob should complete verification");
        };
        assert_eq!(bob_verified.peer_device, alice_dev);
        assert_eq!(bob_verified.peer_master_key, alice_master);

        let SasMessage::Mac {
            master_key: b_m,
            mac: b_mac,
            ..
        } = &bob_mac_msg
        else {
            panic!("expected Mac");
        };
        let alice_verified = alice.on_mac(b_m, b_mac, &bob_master).unwrap().unwrap();
        assert_eq!(alice_verified.peer_device, bob_dev);
        assert_eq!(alice_verified.peer_master_key, bob_master);
    }

    #[test]
    fn sas_refuses_key_without_commitment_or_mismatched_commitment_or_swapped_master_key() {
        let (alice_dev, alice_master, bob_dev, bob_master) = pair();
        let (mut alice, _) = SasSession::start("tx-2".into(), alice_dev.clone(), bob_dev.clone());
        let (mut bob, accept) =
            SasSession::accept("tx-2".into(), bob_dev.clone(), alice_dev.clone());
        let SasMessage::Accept { commitment, .. } = &accept else {
            panic!("expected Accept");
        };

        // 1. Key before Accept is refused (no commitment!).
        let fake_key = Sas::new().public_key().to_base64();
        assert_eq!(
            alice.on_key(&fake_key).unwrap_err(),
            Undecryptable::SasWithoutCommitment
        );

        // 2. Responder sends a key that does not match its commitment.
        let (mut alice, _) = SasSession::start("tx-2".into(), alice_dev.clone(), bob_dev.clone());
        let _ = alice.on_accept(commitment).unwrap();
        assert_eq!(
            alice.on_key(&fake_key).unwrap_err(),
            Undecryptable::SasCommitmentMismatch
        );

        // 3. MITM substitutes another master key in the MAC step.
        let (mut alice, _) = SasSession::start("tx-2".into(), alice_dev, bob_dev);
        let SasMessage::Key { key: alice_key, .. } = alice.on_accept(commitment).unwrap() else {
            panic!("expected Key");
        };
        let (_, Some(SasMessage::Key { key: bob_key, .. })) = bob.on_key(&alice_key).unwrap()
        else {
            panic!("expected Key");
        };
        let _ = alice.on_key(&bob_key).unwrap();
        let _ = alice.confirm(&alice_master, &bob_master).unwrap();
        let other_master = CrossSigning::new("bob").unwrap().master_key();
        let (SasMessage::Mac { mac: bad_mac, .. }, _) =
            bob.confirm(&other_master, &alice_master).unwrap()
        else {
            panic!("expected Mac");
        };
        assert_eq!(
            alice
                .on_mac(&bob_master, &bad_mac, &bob_master)
                .unwrap_err(),
            Undecryptable::SasMacInvalid
        );
    }
}
