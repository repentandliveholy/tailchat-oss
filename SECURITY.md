# Security

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's
private vulnerability reporting (the repository's *Security → Report a
vulnerability* button). You will get an answer within a week. Please include
the version (`tailchat --version`, or the version shown in the web/Android
settings) and steps to reproduce.

## What end-to-end encryption covers

Tailchat encrypts messages end to end with [vodozemac](https://github.com/matrix-org/vodozemac)
(Olm/Megolm, the same primitives as Matrix). The project ships no cryptographic
primitives of its own. The full design is in
[`docs/specs/2026-11-04-e2ee.md`](docs/specs/2026-11-04-e2ee.md).

**Encrypted end to end:** message text, pictures, voice notes, replies, forwards
and edits, once every device on both sides has keys. A conversation that was
encrypted once never silently falls back to plaintext.

**Not hidden from the server:** who talks to whom, when, message sizes and ids,
delivery and read receipts, typing indicators, deletions, reaction emoji, and
call signalling. Conversations with bots (the `tailchat` service account,
Tailik, reminder bots) are not encrypted and are marked as such. History stored
before encryption was turned on stays as it was: encrypted at rest on the
server, not end to end.

**Known limits, stated plainly:**

- **The web client is code served by the same server.** A malicious server
  could ship JavaScript that steals keys. End-to-end encryption in the browser
  is only as strong as your trust in the server that serves the page. The
  terminal client and the Android app are installed separately and do not
  share this weakness.
- **The server keeps the device list.** It could add a fake device to a
  contact. Cross-signing and the safety code (`/verify`, `/safety`) make such a
  device visible as a warning, and an unsigned device gets no conversation keys.
- **The server controls delivery.** It can delay, drop or reorder messages and
  set the timestamp shown on screen. It cannot change the text, author or id of
  an encrypted message.
- **Plaintext before the first encrypted message.** Until a conversation has
  carried one encrypted message, a server that claims a contact has a device
  without keys can keep it in plaintext. The client marks such messages
  *not encrypted*.

## Server-side protections

- Passwords are hashed with scrypt; session tokens are stored only as SHA-256
  digests.
- Data on disk is sealed with AEAD under a master key that must live outside
  the data directory with `0600` permissions.
- Login, registration and recovery are rate limited per address (IPv6 counted
  per /64) and, for sign-in, per account.
- Link previews are fetched with SSRF protection (private, CGNAT and metadata
  ranges are refused, and the address is re-checked on every redirect).
- Every response carries a Content-Security-Policy, `X-Frame-Options` and
  `nosniff`; attachments are never served as documents.

Self-hosting knobs for a public server (all off by default):

| Variable | Effect |
|---|---|
| `TAILCHAT_CLOUD_PASSWORD_MIN` | Shortest new password accepted (default `1`; `10` or more is recommended for an open server). Existing passwords keep working. |
| `TAILCHAT_CLOUD_TOKEN_IDLE_DAYS` | Sign a session out after this many days unused (default `0`, never). |
| `TAILCHAT_GITHUB_REPO` + `TAILCHAT_GITHUB_TOKEN` | Where in-app bug reports go. Without both, reporting is off. Use a **private** repository: reports quote what people typed. |

## Supported versions

Only the latest release gets fixes.
