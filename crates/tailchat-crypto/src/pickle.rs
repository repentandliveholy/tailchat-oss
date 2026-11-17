//! The stored form of every object holding secrets: versioned JSON.
//!
//! Not encrypted here: pickles live in SQLCipher, and a second key derived
//! from the same device key would add nothing (§6). The text is
//! `Zeroizing`; the serialiser's own intermediate buffers are not — the
//! honest limit of doing this in safe Rust.

use serde::Serialize;
use serde::de::DeserializeOwned;
use zeroize::Zeroizing;

use crate::CryptoError;

const VERSION: u8 = 1;

#[derive(Serialize)]
struct Out<'a, T> {
    v: u8,
    p: &'a T,
}

#[derive(serde::Deserialize)]
struct In<T> {
    v: u8,
    p: T,
}

pub(crate) fn to_pickle<T: Serialize>(value: &T) -> Result<Zeroizing<String>, CryptoError> {
    serde_json::to_string(&Out {
        v: VERSION,
        p: value,
    })
    .map(Zeroizing::new)
    .map_err(|_| CryptoError::Pickle {
        reason: "unreadable",
    })
}

pub(crate) fn from_pickle<T: DeserializeOwned>(text: &str) -> Result<T, CryptoError> {
    let parsed: In<T> = serde_json::from_str(text).map_err(|_| CryptoError::Pickle {
        reason: "unreadable",
    })?;
    if parsed.v == VERSION {
        Ok(parsed.p)
    } else {
        Err(CryptoError::Pickle { reason: "version" })
    }
}
