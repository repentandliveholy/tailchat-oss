//! The safety code: a pair of accounts' master keys as emojis that stay the
//! same until either account resets its keys, so two people can compare them
//! whenever they talk — no handshake, nobody else online (owner, 2026-11-11:
//! «разве они не должны всегда показываться например в настройках аккаунта»).
//!
//! SAS ([`crate::SasSession`]) gets away with seven emojis because its
//! commitments leave no time to search; a code that never changes can be
//! ground at offline for as long as an attacker likes. So, as in Signal's
//! safety numbers, each account's half depends on that account's key alone —
//! an impostor has to hit one fixed half (a second preimage), not any two
//! that agree (a collision) — and each half is long and slow to make: ten
//! emojis (60 bits) after 5200 rounds of SHA-512, about 2⁷² hashes to forge.
//!
//! Both people see the same twenty emojis in the same order: the halves are
//! placed by login, the alphabetically first account's ten first.

use sha2::{Digest, Sha512};

use crate::CryptoError;
use crate::device::parse_ed;

/// Emojis in one account's half of a safety code.
pub const SAFETY_EMOJIS_PER_ACCOUNT: usize = 10;

/// SHA-512 rounds per half (Signal's count): the cost of every forging try.
const ROUNDS: usize = 5200;

/// Names this derivation, so the same key never yields the same bytes for
/// anything else.
const LABEL: &[u8] = b"tailchat-safety-code-v1\0";

/// One account's half: its login and its master key's emojis (indices into
/// [`crate::SAS_EMOJIS`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafetyHalf {
    /// The account.
    pub login: String,
    /// Ten indices, 0..64.
    pub emoji_indices: [u8; SAFETY_EMOJIS_PER_ACCOUNT],
}

/// The safety code of two accounts, the alphabetically first login's half
/// first — the same value on both sides.
///
/// # Errors
/// `InvalidKey` when either master key is not an Ed25519 public key.
pub fn safety_code(
    a_login: &str,
    a_master: &str,
    b_login: &str,
    b_master: &str,
) -> Result<[SafetyHalf; 2], CryptoError> {
    let a = SafetyHalf {
        login: a_login.to_owned(),
        emoji_indices: half(a_login, a_master)?,
    };
    let b = SafetyHalf {
        login: b_login.to_owned(),
        emoji_indices: half(b_login, b_master)?,
    };
    Ok(if a.login <= b.login { [a, b] } else { [b, a] })
}

/// Names the numeric form's derivation: the same keys give unrelated bytes
/// for the emojis and for the digits.
const NUMBER_LABEL: &[u8] = b"tailchat-safety-number-v1\0";

/// Digit groups in one account's half of the safety number.
pub const SAFETY_NUMBER_GROUPS_PER_ACCOUNT: usize = 3;

/// The safety code of two accounts as one number: 30 digits in six groups of
/// five, separated by spaces, the alphabetically first login's three groups
/// first — the same string on both sides. Each half depends on its own
/// account's key alone, as the emoji form's does, and is made the same slow
/// way (5200 rounds of SHA-512, its own label); each group is five bytes of
/// the digest, big-endian, mod 100000 — Signal's construction.
///
/// # Errors
/// `InvalidKey` when either master key is not an Ed25519 public key.
pub fn safety_number(
    a_login: &str,
    a_master: &str,
    b_login: &str,
    b_master: &str,
) -> Result<String, CryptoError> {
    let a = number_half(a_login, a_master)?;
    let b = number_half(b_login, b_master)?;
    let (first, second) = if a_login <= b_login { (a, b) } else { (b, a) };
    Ok(first
        .iter()
        .chain(second.iter())
        .map(|group| format!("{group:05}"))
        .collect::<Vec<_>>()
        .join(" "))
}

/// `login`'s three five-digit groups for `master_b64`.
fn number_half(
    login: &str,
    master_b64: &str,
) -> Result<[u64; SAFETY_NUMBER_GROUPS_PER_ACCOUNT], CryptoError> {
    let digest = stretched(NUMBER_LABEL, login, master_b64)?;
    let mut out = [0_u64; SAFETY_NUMBER_GROUPS_PER_ACCOUNT];
    for (slot, chunk) in out.iter_mut().zip(digest.chunks_exact(5)) {
        let value = chunk
            .iter()
            .fold(0_u64, |acc, byte| (acc << 8) | u64::from(*byte));
        *slot = value % 100_000;
    }
    Ok(out)
}

/// `label ‖ len(login) ‖ login ‖ key`, hashed, then re-hashed with the key
/// [`ROUNDS`] times in all.
fn stretched(label: &[u8], login: &str, master_b64: &str) -> Result<[u8; 64], CryptoError> {
    let key = parse_ed(master_b64)?;
    let key = key.as_bytes();
    let mut hash = Sha512::new();
    hash.update(label);
    hash.update(u32::try_from(login.len()).unwrap_or(u32::MAX).to_be_bytes());
    hash.update(login.as_bytes());
    hash.update(key);
    let mut digest = hash.finalize();
    for _ in 1..ROUNDS {
        let mut hash = Sha512::new();
        hash.update(digest);
        hash.update(key);
        digest = hash.finalize();
    }
    Ok(digest.into())
}

/// `login`'s ten emojis for `master_b64`.
fn half(login: &str, master_b64: &str) -> Result<[u8; SAFETY_EMOJIS_PER_ACCOUNT], CryptoError> {
    let key = parse_ed(master_b64)?;
    let key = key.as_bytes();
    let mut hash = Sha512::new();
    hash.update(LABEL);
    // Logins are at most 32 characters; the length keeps `login ‖ key`
    // unambiguous anyway.
    hash.update(u32::try_from(login.len()).unwrap_or(u32::MAX).to_be_bytes());
    hash.update(login.as_bytes());
    hash.update(key);
    let mut digest = hash.finalize();
    for _ in 1..ROUNDS {
        let mut hash = Sha512::new();
        hash.update(digest);
        hash.update(key);
        digest = hash.finalize();
    }
    // A SHA-512 digest is 64 bytes: the first eight are always there.
    let mut top = [0_u8; 8];
    for (slot, byte) in top.iter_mut().zip(digest.iter()) {
        *slot = *byte;
    }
    let bits = u64::from_be_bytes(top);
    let mut out = [0_u8; SAFETY_EMOJIS_PER_ACCOUNT];
    for (i, slot) in out.iter_mut().enumerate() {
        // Six bits each, from the top: 64 − 6·(i + 1).
        let shift = 58 - 6 * i;
        *slot = u8::try_from((bits >> shift) & 63).unwrap_or(0);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Account, DeviceKind};

    fn master(login: &str) -> String {
        Account::new(login, "AAAAAAAAAAAAAAAA", DeviceKind::Client)
            .expect("account")
            .cross_signing()
            .master_key()
    }

    #[test]
    fn both_sides_see_the_same_code() {
        let (a, b) = (master("alice"), master("bob"));
        let mine = safety_code("alice", &a, "bob", &b).expect("code");
        let theirs = safety_code("bob", &b, "alice", &a).expect("code");
        assert_eq!(mine, theirs);
        assert_eq!(mine[0].login, "alice");
        assert_eq!(mine[1].login, "bob");
        assert!(mine.iter().all(|h| h.emoji_indices.iter().all(|&i| i < 64)));
    }

    #[test]
    fn each_half_depends_on_its_own_key_alone() {
        let (a, b, c) = (master("alice"), master("bob"), master("bob"));
        let before = safety_code("alice", &a, "bob", &b).expect("code");
        let after = safety_code("alice", &a, "bob", &c).expect("code");
        assert_eq!(before[0], after[0], "alice's half must not move");
        assert_ne!(before[1], after[1], "bob's new key must show");
    }

    #[test]
    fn the_login_is_part_of_the_half() {
        let key = master("alice");
        let one = half("alice", &key).expect("half");
        let other = half("alicf", &key).expect("half");
        assert_ne!(one, other);
    }

    #[test]
    fn a_known_key_gives_a_fixed_code() {
        // Pins the derivation: a change to it changes every code people have
        // compared, so it must come with a new label, never by accident. The
        // value was checked against an independent SHA-512 loop in Node.
        let key = vodozemac::Ed25519SecretKey::from_slice(&[7; 32])
            .public_key()
            .to_base64();
        let pinned = half("alice", &key).expect("half");
        assert_eq!(pinned, PINNED_ALICE);
    }

    const PINNED_ALICE: [u8; SAFETY_EMOJIS_PER_ACCOUNT] = [9, 60, 26, 4, 47, 45, 33, 39, 27, 18];

    #[test]
    fn both_sides_see_the_same_number() {
        let (a, b) = (master("alice"), master("bob"));
        let mine = safety_number("alice", &a, "bob", &b).expect("number");
        let theirs = safety_number("bob", &b, "alice", &a).expect("number");
        assert_eq!(mine, theirs);
        let groups: Vec<&str> = mine.split(' ').collect();
        assert_eq!(groups.len(), 6);
        assert!(
            groups
                .iter()
                .all(|g| g.len() == 5 && g.bytes().all(|c| c.is_ascii_digit()))
        );
    }

    #[test]
    fn each_number_half_depends_on_its_own_key_alone() {
        let (a, b, c) = (master("alice"), master("bob"), master("bob"));
        let before = safety_number("alice", &a, "bob", &b).expect("number");
        let after = safety_number("alice", &a, "bob", &c).expect("number");
        assert_eq!(before[..17], after[..17], "alice's groups must not move");
        assert_ne!(before[18..], after[18..], "bob's new key must show");
    }

    #[test]
    fn known_keys_give_a_fixed_number() {
        // Pins the derivation, as `a_known_key_gives_a_fixed_code` does for
        // the emojis: a change here changes every number people compared. The
        // value was checked against an independent SHA-512 loop in Node.
        let alice = vodozemac::Ed25519SecretKey::from_slice(&[7; 32])
            .public_key()
            .to_base64();
        let bob = vodozemac::Ed25519SecretKey::from_slice(&[9; 32])
            .public_key()
            .to_base64();
        let number = safety_number("bob", &bob, "alice", &alice).expect("number");
        assert_eq!(number, PINNED_NUMBER);
    }

    const PINNED_NUMBER: &str = "97912 53269 27329 90678 70349 82937";

    #[test]
    fn the_number_does_not_repeat_the_emoji_bytes() {
        let key = master("alice");
        let emoji = stretched(LABEL, "alice", &key).expect("digest");
        let number = stretched(NUMBER_LABEL, "alice", &key).expect("digest");
        assert_ne!(emoji, number);
    }

    #[test]
    fn a_bad_key_is_an_error() {
        assert!(safety_number("alice", "nope", "bob", &master("bob")).is_err());
        assert!(safety_code("alice", "nope", "bob", &master("bob")).is_err());
    }
}
