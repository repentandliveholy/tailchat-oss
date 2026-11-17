//! The work behind `Core::handle`. Only an authenticated socket pumps the queue.

use crate::api::{Event, Extra, MessageKind, Outgoing, Output, StoreOp};
use crate::error::CoreError;
use crate::frames::inner::Image;
use crate::frames::{self, Inner, ServerFrame, User};
use crate::ids::{MessageId, Seq, Ts};
use crate::login::Login;
use crate::receipt::Receipt;

use super::Core;

impl Core {
    /// The account this core works for.
    pub fn me(&self) -> &Login {
        &self.me
    }

    /// How far the sync-v1 feed has been read.
    pub fn cursor(&self) -> Seq {
        self.cursor
    }

    /// Whether the server answered `ready` on the current connection; false
    /// after `Disconnected`, a socket write failure or an auth refusal.
    pub fn is_ready(&self) -> bool {
        self.ready
    }

    /// When to schedule the next Tick: a queued write, or a history walk or
    /// key request waiting out a pause. Offline and manual-retry-only queues
    /// have no timer. The driver re-arms it after every input it handles.
    pub fn next_wakeup(&self) -> Option<Ts> {
        if self.ready {
            let e2ee = &self.e2ee;
            [
                self.outbox.next_wakeup(&|row| e2ee.sendable(row)),
                self.sync.wakeup(),
                self.e2ee.wakeup(self.outbox.gate()),
            ]
            .into_iter()
            .flatten()
            .min()
        } else {
            None
        }
    }

    /// A bad frame becomes a UI event, never a failed call or lost queue.
    pub(super) fn on_frame(&mut self, now: Ts, raw: &str) -> Vec<Output> {
        let frame = match frames::decode(raw) {
            Ok(frame) => frame,
            Err(error) => {
                return vec![Output::Event(Event::BadFrame {
                    reason: error.to_string(),
                })];
            }
        };
        let mut out = match frame {
            ServerFrame::Ready(ready) => {
                if ready.me.as_ref().is_some_and(|me| me.login != self.me) {
                    self.ready = false;
                    return vec![Output::Event(Event::BadFrame {
                        reason: "ready names a different account".into(),
                    })];
                }
                let feed = ready.has_cap("sync-v1");
                let e2ee = ready.has_cap(frames::e2ee::E2EE_CAP);
                self.set_roster(ready.users.items);
                self.ready = true;
                self.outbox.connected(now);
                let mut out = self.e2ee_connected(e2ee);
                out.extend(self.sync_connected(now, feed));
                out
            }
            ServerFrame::Users(roster) => {
                self.set_roster(roster.users.items);
                Vec::new()
            }
            ServerFrame::MessageAccepted(accepted) => {
                self.accept(&accepted.peer, &accepted.id, accepted.ts)
            }
            ServerFrame::Frame(relayed) => match relayed.d {
                Inner::Message(body) => {
                    self.on_live_message(now, relayed.from, relayed.own, MessageKind::Human, body)
                }
                Inner::Ai(body) => {
                    self.on_live_message(now, relayed.from, relayed.own, MessageKind::Ai, body)
                }
                Inner::Ack(ack) if !relayed.own => {
                    self.outbox
                        .receipt(&relayed.from, &ack.id, ack.delivered_ts, false)
                }
                Inner::Read(read) if !relayed.own => {
                    self.outbox
                        .receipt(&relayed.from, &read.id, read.read_ts, true)
                }
                _ => Vec::new(),
            },
            ServerFrame::SyncPage(page) => self.on_sync_page(page),
            ServerFrame::SyncNudge => self.request_page(),
            ServerFrame::Throttle(throttle) => {
                self.e2ee_throttled();
                self.outbox.throttle(now, i64::from(throttle.window_ms))
            }
            ServerFrame::ToDevice(item) => self.on_to_device(item),
            ServerFrame::ToDeviceAccepted(accepted) => self.on_to_device_accepted(&accepted.id),
            ServerFrame::DeviceListChanged { login } => {
                self.devices_changed(&login);
                Vec::new()
            }
            ServerFrame::Error(error) => match self.key_refused(&error) {
                Some(out) => out,
                None => self.server_error(now, error.code, error.peer, error.id),
            },
            _ => Vec::new(),
        };
        out.extend(self.on_tick(now));
        out
    }

    /// The roster is a whitelist, not a presence list: offline friends are valid.
    fn set_roster(&mut self, users: Vec<User>) {
        self.roster = users
            .into_iter()
            .filter(|u| !u.blocked)
            .map(|u| u.login)
            .collect();
    }

    /// Saves new text before the first wire write. A full queue rejects the
    /// new action; existing rows, including failed ones, are never evicted.
    pub(super) fn send_text(
        &mut self,
        now: Ts,
        id: MessageId,
        peer: Login,
        text: String,
    ) -> Result<Vec<Output>, CoreError> {
        if text.trim().is_empty() {
            return Err(CoreError::EmptyText);
        }
        let message = Outgoing {
            extra: Default::default(),
            id,
            peer,
            ts: now,
            text,
            image: None,
            receipt: Receipt::Queued,
        };
        let mut out = self.outbox.enqueue(message, now)?;
        out.extend(self.on_tick(now));
        Ok(out)
    }

    /// Saves a picture under the same rules as text: the same queue, seal and
    /// receipt ladder, and nothing reaches the disk that no frame can carry.
    pub(super) fn send_image(
        &mut self,
        now: Ts,
        id: MessageId,
        peer: Login,
        text: String,
        image: Image,
    ) -> Result<Vec<Output>, CoreError> {
        self.send_with(now, id, peer, text, Some(image), Box::default())
    }

    /// Saves a message with a picture, a quote, a forward label or a voice
    /// note. Each attachment is checked against both wire forms before it is
    /// queued: open, exactly the frame the queue would write; encrypted, the
    /// header and the bytes inside one ciphertext under `MAX_SEALED`.
    pub(super) fn send_with(
        &mut self,
        now: Ts,
        id: MessageId,
        peer: Login,
        text: String,
        image: Option<Image>,
        extra: Box<Extra>,
    ) -> Result<Vec<Output>, CoreError> {
        if extra.edit_of.is_some() {
            return Err(CoreError::InvalidImage {
                reason: "an edit is Action::EditText",
            });
        }
        if image.is_some() && extra.voice.is_some() {
            return Err(CoreError::InvalidImage {
                reason: "one message carries a picture or a voice note, not both",
            });
        }
        let mut blob_len = 0;
        if let Some(image) = &image {
            if image.data_url.len() > frames::MAX_MEDIA_URL {
                return Err(CoreError::FrameTooLarge {
                    len: image.data_url.len(),
                    max: frames::MAX_MEDIA_URL,
                });
            }
            let Some(bytes) = frames::inner::image_bytes(&image.data_url) else {
                return Err(CoreError::InvalidImage {
                    reason: "not a data:image/{jpeg,png,gif,webp};base64 picture, or its base64 does not decode",
                });
            };
            blob_len = bytes.len();
        }
        if let Some(voice) = &extra.voice {
            if voice.data_url.len() > frames::MAX_MEDIA_URL {
                return Err(CoreError::FrameTooLarge {
                    len: voice.data_url.len(),
                    max: frames::MAX_MEDIA_URL,
                });
            }
            let Some((_, bytes)) = frames::inner::voice_bytes(&voice.data_url) else {
                return Err(CoreError::InvalidImage {
                    reason: "not a data:audio/<type>;base64 voice note, or its base64 does not decode",
                });
            };
            if voice.waveform.len() > frames::inner::WAVEFORM_MAX {
                return Err(CoreError::InvalidImage {
                    reason: "a waveform has at most 128 bars",
                });
            }
            blob_len = bytes.len();
        }
        if text.trim().is_empty() && image.is_none() && extra.voice.is_none() {
            return Err(CoreError::EmptyText);
        }
        let message = Outgoing {
            id,
            peer,
            ts: now,
            text,
            image,
            extra,
            receipt: Receipt::Queued,
        };
        frames::msg(&message)?;
        let sealed = super::keys::sealed_frame_chars(
            &self.me,
            &message,
            blob_len,
            super::keys::MediaForm::Blob,
        );
        if self.e2ee.enabled && sealed > frames::MAX_SEALED {
            return Err(CoreError::FrameTooLarge {
                len: sealed,
                max: frames::MAX_SEALED,
            });
        }
        let mut out = self.outbox.enqueue(message, now)?;
        out.extend(self.on_tick(now));
        Ok(out)
    }

    /// New text for a message of ours. In an encrypted conversation the
    /// server cannot apply it (it refuses an open `edit` of an encrypted
    /// record) and must not read it, so it goes as an encrypted message of
    /// its own; the target changes here at once. Otherwise it is the server's
    /// open `edit`, which needs the socket.
    pub(super) fn edit_text(
        &mut self,
        now: Ts,
        id: MessageId,
        peer: Login,
        target: MessageId,
        text: String,
    ) -> Result<Vec<Output>, CoreError> {
        if text.trim().is_empty() {
            return Err(CoreError::EmptyText);
        }
        if !self.e2ee.enabled || !self.e2ee.encrypted.contains(&peer) {
            if !self.ready {
                return Err(CoreError::NotReady);
            }
            return Ok(vec![Output::Send(frames::en::edit(
                &peer, &target, &text, None,
            )?)]);
        }
        let message = Outgoing {
            id,
            peer: peer.clone(),
            ts: now,
            text: text.clone(),
            image: None,
            extra: Box::new(Extra {
                edit_of: Some(target.clone()),
                ..Extra::default()
            }),
            receipt: Receipt::Queued,
        };
        let sealed =
            super::keys::sealed_frame_chars(&self.me, &message, 0, super::keys::MediaForm::Blob);
        if sealed > frames::MAX_SEALED {
            return Err(CoreError::FrameTooLarge {
                len: sealed,
                max: frames::MAX_SEALED,
            });
        }
        let queued = self.outbox.enqueue(message, now)?;
        let me = self.me.clone();
        let mut out = self.carrier_edit(&peer, &target, &me, text, now);
        out.extend(queued);
        out.extend(self.on_tick(now));
        Ok(out)
    }

    /// Applies an encrypted edit by `author` to `target`: the store checks
    /// the author, and an edit no newer than the target's last one is
    /// ignored, so a history page cannot replay an old carrier over a new one.
    pub(super) fn carrier_edit(
        &mut self,
        peer: &Login,
        target: &MessageId,
        author: &Login,
        text: String,
        at: Ts,
    ) -> Vec<Output> {
        let newer = self
            .sync
            .edited(peer, target)
            .is_some_and(|local| Some(at) > local);
        if !newer {
            return Vec::new();
        }
        let mine = *author == self.me;
        self.sync.hold(peer.clone(), target.clone(), Some(at));
        if mine {
            self.outbox.edit_sent(peer, target, &text);
        }
        vec![
            Output::Persist(vec![StoreOp::SealedEdit {
                peer: peer.clone(),
                id: target.clone(),
                author: author.clone(),
                mine,
                text,
                edited_at: at,
            }]),
            Output::Event(Event::MessageStored {
                peer: peer.clone(),
                id: target.clone(),
            }),
        ]
    }

    /// Timer input; no socket means no send, no attempts and no time-based
    /// failure. A history walk owed and due starts here too.
    pub(super) fn on_tick(&mut self, now: Ts) -> Vec<Output> {
        if !self.ready {
            return Vec::new();
        }
        let mut out = self.e2ee_send_keys(now);
        out.extend(self.seal_due(now));
        let e2ee = &self.e2ee;
        out.extend(
            self.outbox
                .poll(now, &self.roster, &self.me, &|row| e2ee.sendable(row)),
        );
        out.extend(self.drain(now));
        out.extend(self.e2ee_drain(now));
        out
    }

    /// Reuses a failed row's original id and resets its attempt budget.
    pub(super) fn retry(
        &mut self,
        now: Ts,
        peer: Login,
        id: MessageId,
    ) -> Result<Vec<Output>, CoreError> {
        let mut out = self.outbox.retry(now, &peer, &id)?;
        out.extend(self.on_tick(now));
        Ok(out)
    }

    /// A socket rejected a particular write: do not charge an online attempt.
    /// The driver stops the batch and reconnects; readiness must be established again.
    pub(super) fn write_failed(&mut self, peer: &Login, id: &MessageId) -> Vec<Output> {
        self.ready = false;
        self.outbox.write_failed(peer, id)
    }

    /// Server refusals are surfaced with their original code. Only a permanent
    /// refusal with a known `(peer,id)` can fail that row. Disk failures retry.
    fn server_error(
        &mut self,
        now: Ts,
        code: String,
        peer: Option<Login>,
        id: Option<MessageId>,
    ) -> Vec<Output> {
        let mut out = Vec::new();
        if code == "auth_failed" || code == "auth_required" {
            self.ready = false;
        }
        if code == "rate_limited" {
            out.extend(self.outbox.throttle(now, 1000));
        }
        if matches!(
            code.as_str(),
            "message_id_conflict" | "blocked" | "peer_not_found" | "frame_too_large"
        ) && let (Some(peer), Some(id)) = (&peer, &id)
        {
            out.extend(self.outbox.rejected(peer, id, &code));
        }
        if !out
            .iter()
            .any(|o| matches!(o, Output::Event(Event::ServerError { .. })))
        {
            out.push(Output::Event(Event::ServerError { code, peer, id }));
        }
        out
    }
}
