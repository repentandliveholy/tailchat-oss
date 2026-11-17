//! Canonical JSON and the signatures over it.
//!
//! The bytes are those of `canonicalJson` in `src/identity.js`: object keys
//! sorted by UTF-16 code unit (JavaScript's `sort()`), no whitespace, strings
//! escaped as `JSON.stringify` escapes them. A signed object carries its
//! signatures as `signatures: {login: {"ed25519:<id>": "<base64>"}}`; that
//! field and `unsigned` are left out of what is signed. Pinned by
//! `tests/fixtures/signing-vectors.json` (produced by `node:crypto`).

use std::fmt::Write as _;

use serde_json::{Map, Value};
use vodozemac::{Ed25519PublicKey, Ed25519Signature};

use crate::CryptoError;

/// The largest integer every JavaScript engine prints exactly.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const SIGNATURES: &str = "signatures";
const UNSIGNED: &str = "unsigned";

/// The canonical form of `value`.
///
/// # Errors
/// [`CryptoError::NotCanonical`] for a float or an integer beyond ±(2⁵³ − 1).
pub fn canonical_json(value: &Value) -> Result<String, CryptoError> {
    let mut out = String::new();
    write_value(&mut out, value)?;
    Ok(out)
}

fn write_value(out: &mut String, value: &Value) -> Result<(), CryptoError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => write_number(out, number)?,
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item)?;
            }
            out.push(']');
        }
        Value::Object(map) => write_object(out, map.iter())?,
    }
    Ok(())
}

fn write_object<'a>(
    out: &mut String,
    entries: impl Iterator<Item = (&'a String, &'a Value)>,
) -> Result<(), CryptoError> {
    let mut entries: Vec<_> = entries.collect();
    entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    out.push('{');
    for (i, (key, item)) in entries.into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_string(out, key);
        out.push(':');
        write_value(out, item)?;
    }
    out.push('}');
    Ok(())
}

fn write_number(out: &mut String, number: &serde_json::Number) -> Result<(), CryptoError> {
    let safe = number
        .as_u64()
        .filter(|n| *n <= MAX_SAFE_INTEGER)
        .map(|n| n.to_string())
        .or_else(|| {
            number
                .as_i64()
                .filter(|n| n.unsigned_abs() <= MAX_SAFE_INTEGER)
                .map(|n| n.to_string())
        });
    let text = safe.ok_or(CryptoError::NotCanonical {
        reason: "not an integer within ±(2^53 - 1)",
    })?;
    out.push_str(&text);
    Ok(())
}

/// `JSON.stringify` of a string: only `"`, `\` and C0 controls are escaped.
fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                // Writing to a String cannot fail.
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// What a signature over `object` covers.
fn signed_bytes(object: &Map<String, Value>) -> Result<String, CryptoError> {
    let mut out = String::new();
    write_object(
        &mut out,
        object
            .iter()
            .filter(|(key, _)| key.as_str() != SIGNATURES && key.as_str() != UNSIGNED),
    )?;
    Ok(out)
}

/// The id an Ed25519 key (a device id or a public key's base64) signs under.
pub(crate) fn device_key_id(id: &str) -> String {
    format!("ed25519:{id}")
}

/// Sign `object` with `sign` and add the signature under `login`/`key_id`,
/// keeping any signature already there from other keys.
pub(crate) fn sign_object(
    object: &mut Map<String, Value>,
    login: &str,
    key_id: &str,
    sign: impl FnOnce(&[u8]) -> Ed25519Signature,
) -> Result<(), CryptoError> {
    let signature = sign(signed_bytes(object)?.as_bytes()).to_base64();
    let signatures = object
        .entry(SIGNATURES)
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(signatures) = signatures else {
        return Err(CryptoError::BadSignature);
    };
    let by_login = signatures
        .entry(login)
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(by_login) = by_login else {
        return Err(CryptoError::BadSignature);
    };
    by_login.insert(key_id.to_owned(), Value::String(signature));
    Ok(())
}

/// Check the signature `login`/`key_id` on `object` against `key`.
pub(crate) fn verify_object(
    object: &Map<String, Value>,
    login: &str,
    key_id: &str,
    key: &Ed25519PublicKey,
) -> Result<(), CryptoError> {
    let signature = object
        .get(SIGNATURES)
        .and_then(|s| s.get(login))
        .and_then(|s| s.get(key_id))
        .and_then(Value::as_str)
        .ok_or(CryptoError::BadSignature)?;
    let signature =
        Ed25519Signature::from_base64(signature).map_err(|_| CryptoError::BadSignature)?;
    key.verify(signed_bytes(object)?.as_bytes(), &signature)
        .map_err(|_| CryptoError::BadSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use vodozemac::Ed25519SecretKey;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/signing-vectors.json")).unwrap()
    }

    fn seed_key(v: &Value) -> Ed25519SecretKey {
        let seed = vodozemac::base64_decode(v["seed"].as_str().unwrap()).unwrap();
        Ed25519SecretKey::from_slice(&seed.try_into().unwrap())
    }

    #[test]
    fn matches_javascript_bytes_and_signature() {
        let v = vectors();
        let key = seed_key(&v);
        assert_eq!(key.public_key().to_base64(), v["ed25519"].as_str().unwrap());

        let mut object = v["generic"]["value"].as_object().unwrap().clone();
        assert_eq!(
            signed_bytes(&object).unwrap(),
            v["generic"]["canonical"].as_str().unwrap()
        );
        object.remove(SIGNATURES);
        sign_object(&mut object, "alice", "ed25519:K", |m| key.sign(m)).unwrap();
        assert_eq!(
            object[SIGNATURES]["alice"]["ed25519:K"],
            v["generic"]["signature"]
        );
        verify_object(&object, "alice", "ed25519:K", &key.public_key()).unwrap();
    }

    #[test]
    fn any_change_breaks_the_signature() {
        let key = Ed25519SecretKey::new();
        let mut object = json!({"login": "alice", "n": 1})
            .as_object()
            .unwrap()
            .clone();
        sign_object(&mut object, "alice", "ed25519:K", |m| key.sign(m)).unwrap();
        let public = key.public_key();

        // Unsigned fields may change; signed ones may not.
        object.insert(UNSIGNED.into(), json!({"name": "phone"}));
        verify_object(&object, "alice", "ed25519:K", &public).unwrap();
        object.insert("n".into(), json!(2));
        assert_eq!(
            verify_object(&object, "alice", "ed25519:K", &public),
            Err(CryptoError::BadSignature)
        );
        object.insert("n".into(), json!(1));
        assert_eq!(
            verify_object(&object, "bob", "ed25519:K", &public),
            Err(CryptoError::BadSignature)
        );
        let other = Ed25519SecretKey::new().public_key();
        assert_eq!(
            verify_object(&object, "alice", "ed25519:K", &other),
            Err(CryptoError::BadSignature)
        );
    }

    #[test]
    fn refuses_what_javascript_would_print_differently() {
        assert!(canonical_json(&json!(1.5)).is_err());
        assert!(canonical_json(&json!(9_007_199_254_740_992_u64)).is_err());
        assert!(canonical_json(&json!(-9_007_199_254_740_992_i64)).is_err());
        assert_eq!(canonical_json(&json!(-0)).unwrap(), "0");
    }
}
