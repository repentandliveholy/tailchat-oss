//! Lists read tolerantly: one element that does not fit costs that element.

use std::fmt;

use serde::Deserialize;
use serde::de::{self, Deserializer, IgnoredAny, SeqAccess, Visitor};

/// A list from the wire, minus whatever could not be read.
///
/// The server writes every list it sends, but a list can still arrive
/// shortened by a newer server or a truncated frame; a single bad entry must
/// not cost the whole page (spec §4: a bad event in `sync-page` is skipped,
/// not fatal).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lossy<T> {
    /// The entries that could be read, in order.
    pub items: Vec<T>,
    /// How many entries were there but could not be read.
    pub skipped: usize,
}

impl<T> Default for Lossy<T> {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            skipped: 0,
        }
    }
}

/// Reads one value of type `T`, or `None` when it is missing, `null` or of
/// another shape. The value is read through the same buffered path serde uses
/// for a tagged enum, so a wrong shape costs the field and nothing else.
pub(crate) fn lenient<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(match Option::<Maybe<T>>::deserialize(deserializer)? {
        Some(Maybe::Value(value)) => Some(value),
        Some(Maybe::Skipped) | None => None,
    })
}

impl<T> Lossy<T> {
    /// An empty list.
    pub fn new() -> Self {
        Self::default()
    }

    /// The entries, with one unusable entry counted.
    pub fn of(items: Vec<T>) -> Self {
        Self { items, skipped: 0 }
    }
}

/// One entry of a [`Lossy`] list: either it fits, or it is thrown away.
pub(crate) enum Maybe<T> {
    /// An entry that deserialized cleanly.
    Value(T),
    /// An entry of the wrong shape; counted, never kept.
    Skipped,
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Maybe<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        /// Tries the real type first, then accepts anything else.
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr<T> {
            Value(T),
            Wrong(IgnoredAny),
        }
        Ok(match Repr::<T>::deserialize(deserializer)? {
            Repr::Value(value) => Self::Value(value),
            Repr::Wrong(_) => Self::Skipped,
        })
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Lossy<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ListVisitor<T>(std::marker::PhantomData<T>);

        impl<'de, T: Deserialize<'de>> Visitor<'de> for ListVisitor<T> {
            type Value = Lossy<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a list")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut list = Lossy::<T>::new();
                while let Some(entry) = seq.next_element::<Maybe<T>>()? {
                    match entry {
                        Maybe::Value(value) => list.items.push(value),
                        Maybe::Skipped => list.skipped = list.skipped.saturating_add(1),
                    }
                }
                Ok(list)
            }

            // Anything that is not a list reads as an empty one: the callers of
            // a list treat "no entries" as safe, and refusing the whole frame
            // would cost far more than the list it could not use.
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(Lossy::new())
            }

            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(Lossy::new())
            }

            fn visit_some<D: Deserializer<'de>>(
                self,
                deserializer: D,
            ) -> Result<Self::Value, D::Error> {
                Lossy::<T>::deserialize(deserializer)
            }

            fn visit_str<E: de::Error>(self, _value: &str) -> Result<Self::Value, E> {
                Ok(Lossy::new())
            }

            fn visit_string<E: de::Error>(self, _value: String) -> Result<Self::Value, E> {
                Ok(Lossy::new())
            }

            fn visit_bool<E: de::Error>(self, _value: bool) -> Result<Self::Value, E> {
                Ok(Lossy::new())
            }

            fn visit_i64<E: de::Error>(self, _value: i64) -> Result<Self::Value, E> {
                Ok(Lossy::new())
            }

            fn visit_u64<E: de::Error>(self, _value: u64) -> Result<Self::Value, E> {
                Ok(Lossy::new())
            }

            fn visit_f64<E: de::Error>(self, _value: f64) -> Result<Self::Value, E> {
                Ok(Lossy::new())
            }

            fn visit_map<M: de::MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Lossy::new())
            }
        }

        deserializer.deserialize_any(ListVisitor(std::marker::PhantomData))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    struct Item {
        n: i64,
    }

    fn read(raw: &str) -> Lossy<Item> {
        serde_json::from_str(raw).expect("list decodes")
    }

    #[test]
    fn keeps_the_good_and_counts_the_bad() {
        let list = read(r#"[{"n":1},{"n":"two"},{"n":3},null,7]"#);
        assert_eq!(list.items, vec![Item { n: 1 }, Item { n: 3 }]);
        assert_eq!(list.skipped, 3);
    }

    #[test]
    fn a_missing_or_odd_list_is_an_empty_one() {
        assert_eq!(read("null"), Lossy::new());
        assert_eq!(read("5"), Lossy::new());
        assert_eq!(read(r#"{"n":1}"#), Lossy::new());
        assert_eq!(read("[]"), Lossy::new());
    }
}
