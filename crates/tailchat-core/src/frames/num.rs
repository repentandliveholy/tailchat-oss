//! Wire numbers: every JSON number is a float on the other side of the wire.
//!
//! The server writes timestamps and sequence numbers it got from JS, so an
//! `ts` can arrive as `1793622391280.5` (`hub.js` keeps a client's clock,
//! `String(number)` prints it that way). Spec §4: accept any finite number and
//! floor it. Anything that is not a number at all is left to the caller to
//! decide about: [`de_ts`] refuses it, the `lenient` helpers return `None`.

use std::fmt;

use serde::Deserialize;
use serde::de::{self, Deserializer, Visitor};

use crate::ids::{Seq, Ts};

/// The most negative `i64`, as the float a JSON reader hands us for it.
const I64_MIN_F64: f64 = -9_223_372_036_854_775_808.0;

/// Floors a finite number to `i64` without an `as` cast, which the workspace
/// lints forbid. `None` for NaN, infinities and anything outside `i64`.
pub fn floor_to_i64(value: f64) -> Option<i64> {
    if !value.is_finite() {
        return None;
    }
    let floored = value.floor();
    if floored == 0.0 {
        return Some(0);
    }
    if floored == I64_MIN_F64 {
        return Some(i64::MIN);
    }

    let bits = floored.to_bits();
    let negative = (bits >> 63) != 0;
    let biased = u32::try_from((bits >> 52) & 0x07ff).ok()?;
    let mantissa = bits & 0x000f_ffff_ffff_ffff;

    // Subnormal, or |value| < 1: the floor is 0 or -1, already handled above
    // for the exact -0.0 case; a negative fraction floors to -1.
    if biased == 0 {
        return if negative { Some(-1) } else { Some(0) };
    }
    let exponent = i32::try_from(biased).ok()? - 1023;
    if exponent < 0 {
        return if negative { Some(-1) } else { Some(0) };
    }
    // 2^63 is the first value i64 cannot hold; only -2^63 fits.
    if exponent > 63 {
        return None;
    }
    if exponent == 63 {
        return None;
    }

    let significand = (1u64 << 52) | mantissa;
    let exponent = u32::try_from(exponent).ok()?;
    let magnitude = if exponent >= 52 {
        significand.checked_shl(exponent.checked_sub(52)?)?
    } else {
        significand >> (52u32.checked_sub(exponent)?)
    };

    if negative {
        if magnitude == 0x8000_0000_0000_0000 {
            Some(i64::MIN)
        } else {
            let positive = i64::try_from(magnitude).ok()?;
            Some(-positive)
        }
    } else {
        i64::try_from(magnitude).ok()
    }
}

/// Accepts any JSON number and returns it floored to `i64`.
struct NumberVisitor;

impl Visitor<'_> for NumberVisitor {
    type Value = i64;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a number")
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
        Ok(value)
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
        i64::try_from(value).map_err(|_| de::Error::custom("number is above i64::MAX"))
    }

    fn visit_i128<E: de::Error>(self, value: i128) -> Result<Self::Value, E> {
        i64::try_from(value).map_err(|_| de::Error::custom("number is outside i64"))
    }

    fn visit_u128<E: de::Error>(self, value: u128) -> Result<Self::Value, E> {
        i64::try_from(value).map_err(|_| de::Error::custom("number is outside i64"))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
        floor_to_i64(value).ok_or_else(|| de::Error::custom("number is not a finite i64"))
    }
}

/// A wire number, floored. `i64` is what `Ts` and `Seq` hold.
fn number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    deserializer.deserialize_any(NumberVisitor)
}

/// Reads a required `ts`.
pub fn de_ts<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Ts, D::Error> {
    number(deserializer).map(Ts)
}

/// Reads an optional `ts`: missing, `null` or unreadable is `None`.
pub fn de_opt_ts<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Ts>, D::Error> {
    optional(deserializer).map(|value| value.map(Ts))
}

/// Reads a required `seq`.
pub fn de_seq<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Seq, D::Error> {
    number(deserializer).map(Seq)
}

/// Reads an optional `seq`: missing, `null` or unreadable is `None`.
pub fn de_opt_seq<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Seq>, D::Error> {
    optional(deserializer).map(|value| value.map(Seq))
}

/// Reads an optional count, losing anything that is not a number.
pub fn de_opt_u32<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u32>, D::Error> {
    optional(deserializer).map(|value| value.and_then(|n| u32::try_from(n).ok()))
}

/// Reads a count, defaulting to 0 when it is not a number.
pub fn de_u32<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    Ok(de_opt_u32(deserializer)?.unwrap_or(0))
}

/// Reads an optional pixel size or duration, losing anything unusable.
pub fn de_opt_i64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    optional(deserializer)
}

/// A number if there is one, `None` if the value is missing, `null` or of
/// another type: an informational number is not worth a broken frame.
fn optional<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    Ok(super::lossy::lenient::<D, Number>(deserializer)?.map(|Number(value)| value))
}

/// A wrapper whose `Deserialize` accepts only real numbers.
struct Number(i64);

impl<'de> Deserialize<'de> for Number {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        number(deserializer).map(Number)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floors_towards_negative_infinity() {
        assert_eq!(floor_to_i64(0.0), Some(0));
        assert_eq!(floor_to_i64(-0.0), Some(0));
        assert_eq!(floor_to_i64(1.5), Some(1));
        assert_eq!(floor_to_i64(-1.5), Some(-2));
        assert_eq!(floor_to_i64(0.999_9), Some(0));
        assert_eq!(floor_to_i64(-0.000_1), Some(-1));
        assert_eq!(floor_to_i64(1e12), Some(1_000_000_000_000));
    }

    #[test]
    fn keeps_the_extremes_and_refuses_the_rest() {
        assert_eq!(floor_to_i64(-9_223_372_036_854_775_808.0), Some(i64::MIN));
        assert_eq!(floor_to_i64(9_223_372_036_854_775_808.0), None);
        assert_eq!(floor_to_i64(1e30), None);
        assert_eq!(floor_to_i64(-1e30), None);
        assert_eq!(floor_to_i64(f64::NAN), None);
        assert_eq!(floor_to_i64(f64::INFINITY), None);
        assert_eq!(floor_to_i64(f64::NEG_INFINITY), None);
    }

    #[test]
    fn ts_accepts_every_finite_shape() {
        let wrapped = |raw: &str| serde_json::from_str::<Wrapped>(raw).map(|value| value.0);
        assert_eq!(wrapped("5").ok(), Some(Ts(5)));
        assert_eq!(wrapped("5.9").ok(), Some(Ts(5)));
        assert!(wrapped("1e30").is_err());
        assert!(wrapped(r#""5""#).is_err());
    }

    #[test]
    fn optional_numbers_lose_what_they_cannot_read() {
        let read = |raw: &str| serde_json::from_str::<Optional>(raw).map(|value| value.v);
        assert_eq!(read(r#"{"v":7}"#).ok(), Some(Some(7)));
        assert_eq!(read(r#"{"v":7.9}"#).ok(), Some(Some(7)));
        assert_eq!(read(r#"{"v":"7"}"#).ok(), Some(None));
        assert_eq!(read(r#"{"v":null}"#).ok(), Some(None));
        assert_eq!(read("{}").ok(), Some(None));
    }

    #[derive(Deserialize)]
    struct Wrapped(#[serde(deserialize_with = "de_ts")] Ts);

    #[derive(Deserialize)]
    struct Optional {
        #[serde(default, deserialize_with = "de_opt_i64")]
        v: Option<i64>,
    }
}
