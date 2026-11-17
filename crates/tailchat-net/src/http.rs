//! The history GET and the key POSTs: a small HTTP/1.1 client, because that
//! is all the core asks for (`Output::Fetch`, `Output::Post`) and a general
//! client would triple the tree.
//!
//! One request per connection (`Connection: close`), identity encoding, no
//! redirects, no proxies. The answer is read as the server frames it
//! (`Content-Length`, `chunked`, or until close) and never past
//! [`MAX_INBOUND`](tailchat_core::MAX_INBOUND): the counting happens while the
//! bytes arrive, so a hostile or broken body costs at most the cap.
//!
//! Anything that is not a clean `200` with a complete body is a
//! [`FetchError`]: a non-200 status is [`FetchError::Status`], a body over the
//! cap is [`FetchError::TooLarge`], everything else (DNS, TCP, TLS, timeout,
//! a truncated or malformed answer) is [`FetchError::Network`].

use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt as _;
use futures_util::future::LocalBoxFuture;

use rustls::ClientConfig;
use rustls::pki_types::ServerName;
use tailchat_core::{FetchError, Refusal};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::http::Uri;
use zeroize::Zeroizing;

/// Longest status line plus headers we read before giving up.
const HEAD_MAX: usize = 16 * 1024;
/// Most header lines `httparse` is given room for.
const HEADERS_MAX: usize = 64;
/// Longest chunked trailer section we skip.
const TRAILER_MAX: usize = 8 * 1024;
/// Most hex digits of one chunk size (`u64`).
const CHUNK_DIGITS_MAX: u8 = 16;
/// Size of the read buffer.
const READ_BUF: usize = 64 * 1024;

/// Where the cloud's HTTP side lives: `Config::http_base` taken apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Endpoint {
    /// `https` rather than `http`.
    tls: bool,
    /// What to resolve and to check the certificate against (an IPv6 literal
    /// without its brackets).
    host: String,
    /// The port, explicit or the scheme's default.
    port: u16,
    /// The `Host` header: the authority exactly as configured.
    authority: String,
    /// The path prefix without a trailing slash: `""` or `"/tailchat"`.
    prefix: String,
}

impl Endpoint {
    /// Takes `http(s)://host[:port][/prefix]` apart; `None` for anything else
    /// (another scheme, user info, a query or fragment).
    pub(crate) fn parse(base: &str) -> Option<Self> {
        let uri: Uri = base.parse().ok()?;
        let tls = match uri.scheme_str()? {
            "https" => true,
            "http" => false,
            _ => return None,
        };
        if uri.query().is_some() || base.contains('#') {
            return None;
        }
        let authority = uri.authority()?;
        if authority.as_str().contains('@') {
            return None;
        }
        let host = authority.host();
        let host = host
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
            .unwrap_or(host);
        if host.is_empty() {
            return None;
        }
        let port = authority.port_u16().unwrap_or(if tls { 443 } else { 80 });
        Some(Self {
            tls,
            host: host.to_owned(),
            port,
            authority: authority.as_str().to_owned(),
            prefix: uri.path().trim_end_matches('/').to_owned(),
        })
    }

    /// The request, ready to write: a `GET`, or a JSON `POST` with `body`.
    /// The bearer token is in it, so the buffer is wiped when it goes.
    fn request(&self, path: &str, token: &str, body: Option<&str>) -> Zeroizing<Vec<u8>> {
        let length = body.map(|b| b.len().to_string());
        let extra = body.map_or(0, str::len);
        let mut out = Zeroizing::new(Vec::with_capacity(400 + path.len() + extra));
        let method = if body.is_some() { "POST " } else { "GET " };
        for part in [
            method,
            self.prefix.as_str(),
            path,
            " HTTP/1.1\r\nHost: ",
            self.authority.as_str(),
            "\r\nAuthorization: Bearer ",
            token,
            "\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nUser-Agent: tailchat-net/",
            env!("CARGO_PKG_VERSION"),
        ] {
            out.extend_from_slice(part.as_bytes());
        }
        if let (Some(body), Some(length)) = (body, &length) {
            for part in [
                "\r\nContent-Type: application/json\r\nContent-Length: ",
                length.as_str(),
                "\r\nConnection: close\r\n\r\n",
                body,
            ] {
                out.extend_from_slice(part.as_bytes());
            }
        } else {
            out.extend_from_slice(b"\r\nConnection: close\r\n\r\n");
        }
        out
    }
}

/// How the server frames the body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Framing {
    /// `Content-Length: n`.
    Length(u64),
    /// `Transfer-Encoding: chunked`.
    Chunked,
    /// Neither: the body ends when the server closes the connection.
    Close,
}

/// A parsed status line and headers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Head {
    /// The status code.
    status: u16,
    /// How the body is framed.
    framing: Framing,
}

/// A malformed or unsupported answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Malformed;

/// Reads the head from `buf`: `Ok(None)` while it is incomplete, otherwise
/// the head and how many bytes it took.
fn parse_head(buf: &[u8]) -> Result<Option<(Head, usize)>, Malformed> {
    let mut headers = [httparse::EMPTY_HEADER; HEADERS_MAX];
    let mut response = httparse::Response::new(&mut headers);
    let used = match response.parse(buf) {
        Ok(httparse::Status::Complete(used)) => used,
        Ok(httparse::Status::Partial) => return Ok(None),
        Err(_) => return Err(Malformed),
    };
    let status = response.code.ok_or(Malformed)?;
    if status < 200 {
        return Err(Malformed);
    }
    let mut chunked = false;
    let mut length: Option<u64> = None;
    for header in response.headers.iter() {
        if header.name.eq_ignore_ascii_case("transfer-encoding") {
            // Anything but a bare `chunked` is a coding we did not ask for.
            if !header.value.trim_ascii().eq_ignore_ascii_case(b"chunked") {
                return Err(Malformed);
            }
            chunked = true;
        } else if header.name.eq_ignore_ascii_case("content-length") {
            let value = decimal(header.value.trim_ascii()).ok_or(Malformed)?;
            if length.is_some_and(|seen| seen != value) {
                return Err(Malformed);
            }
            length = Some(value);
        } else if header.name.eq_ignore_ascii_case("content-encoding")
            && !header.value.trim_ascii().eq_ignore_ascii_case(b"identity")
        {
            return Err(Malformed);
        }
    }
    let framing = match (chunked, length) {
        (true, _) => Framing::Chunked,
        (false, Some(len)) => Framing::Length(len),
        (false, None) => Framing::Close,
    };
    Ok(Some((Head { status, framing }, used)))
}

/// `[0-9]+` as a `u64`; no sign, no spaces, no overflow.
fn decimal(raw: &[u8]) -> Option<u64> {
    if raw.is_empty() {
        return None;
    }
    raw.iter().try_fold(0u64, |acc, byte| {
        let digit = byte.checked_sub(b'0').filter(|d| *d <= 9)?;
        acc.checked_mul(10)?.checked_add(u64::from(digit))
    })
}

/// Where the chunked decoder is in the stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Chunk {
    /// Hex digits of a chunk size; `seen` of them so far.
    Size {
        /// The size so far.
        value: u64,
        /// How many digits.
        seen: u8,
    },
    /// A chunk extension, skipped up to the line's CR.
    Ext {
        /// The size the line announced.
        value: u64,
    },
    /// The CR of a size line is read; its LF comes next.
    SizeLf {
        /// The size the line announced.
        value: u64,
    },
    /// Chunk data, `left` bytes still to come.
    Data {
        /// Bytes still to come.
        left: u64,
    },
    /// The CR after chunk data.
    DataCr,
    /// The LF after chunk data.
    DataLf,
    /// The start of a trailer line (after the last chunk).
    TrailerStart {
        /// Trailer bytes read so far.
        total: usize,
    },
    /// Inside a trailer line.
    Trailer {
        /// Trailer bytes read so far.
        total: usize,
    },
    /// The CR of a trailer line; its LF comes next.
    TrailerLf {
        /// Trailer bytes read so far.
        total: usize,
    },
    /// The CR of the empty line that ends the message.
    TrailerEnd,
    /// The terminating empty line is read.
    Done,
}

/// The body as it arrives, under the size cap.
#[derive(Debug)]
struct Body {
    /// How it is framed.
    framing: Framing,
    /// Bytes of body still expected for `Framing::Length`.
    left: u64,
    /// The decoder's place for `Framing::Chunked`.
    chunk: Chunk,
    /// The body so far.
    out: Vec<u8>,
    /// Longest body accepted.
    cap: usize,
    /// All of it has arrived.
    done: bool,
}

impl Body {
    /// Starts a body. A declared length over the cap fails at once, before a
    /// byte of the body is read.
    fn new(framing: Framing, cap: usize) -> Result<Self, FetchError> {
        let left = match framing {
            Framing::Length(len) => {
                if usize::try_from(len).is_ok_and(|len| len <= cap) {
                    len
                } else {
                    return Err(FetchError::TooLarge);
                }
            }
            Framing::Chunked | Framing::Close => 0,
        };
        Ok(Self {
            framing,
            left,
            chunk: Chunk::Size { value: 0, seen: 0 },
            out: Vec::new(),
            cap,
            done: framing == Framing::Length(0),
        })
    }

    /// Appends `data`, refusing to pass the cap.
    fn push(&mut self, data: &[u8]) -> Result<(), FetchError> {
        if self.out.len().saturating_add(data.len()) > self.cap {
            return Err(FetchError::TooLarge);
        }
        self.out.extend_from_slice(data);
        Ok(())
    }

    /// Takes more bytes off the wire. Bytes after the end of the body are
    /// ignored.
    fn feed(&mut self, mut input: &[u8]) -> Result<(), FetchError> {
        match self.framing {
            Framing::Length(_) => {
                let take = usize::try_from(self.left)
                    .unwrap_or(usize::MAX)
                    .min(input.len());
                let (data, _) = input.split_at_checked(take).ok_or(FetchError::Network)?;
                self.push(data)?;
                self.left = self
                    .left
                    .saturating_sub(u64::try_from(take).unwrap_or(u64::MAX));
                self.done = self.left == 0;
                Ok(())
            }
            Framing::Close => self.push(input),
            Framing::Chunked => {
                while !self.done && !input.is_empty() {
                    if let Chunk::Data { left } = self.chunk {
                        let take = usize::try_from(left).unwrap_or(usize::MAX).min(input.len());
                        let (data, rest) =
                            input.split_at_checked(take).ok_or(FetchError::Network)?;
                        self.push(data)?;
                        let left = left.saturating_sub(u64::try_from(take).unwrap_or(u64::MAX));
                        self.chunk = if left == 0 {
                            Chunk::DataCr
                        } else {
                            Chunk::Data { left }
                        };
                        input = rest;
                    } else {
                        let (byte, rest) = input.split_first().ok_or(FetchError::Network)?;
                        self.step(*byte)?;
                        input = rest;
                    }
                }
                Ok(())
            }
        }
    }

    /// One byte of the chunked grammar outside chunk data. Strict: CRLF
    /// everywhere, lowercase or uppercase hex, no bare LF.
    fn step(&mut self, byte: u8) -> Result<(), FetchError> {
        let bad = FetchError::Network;
        self.chunk = match self.chunk {
            Chunk::Size { value, seen } => match byte {
                b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F' => {
                    let digit = char::from(byte).to_digit(16).ok_or(bad)?;
                    if seen >= CHUNK_DIGITS_MAX {
                        return Err(bad);
                    }
                    Chunk::Size {
                        value: value
                            .checked_mul(16)
                            .and_then(|v| v.checked_add(u64::from(digit)))
                            .ok_or(bad)?,
                        seen: seen.saturating_add(1),
                    }
                }
                b';' if seen > 0 => Chunk::Ext { value },
                b'\r' if seen > 0 => Chunk::SizeLf { value },
                _ => return Err(bad),
            },
            Chunk::Ext { value } => match byte {
                b'\r' => Chunk::SizeLf { value },
                b'\n' => return Err(bad),
                _ => Chunk::Ext { value },
            },
            Chunk::SizeLf { value } => {
                if byte != b'\n' {
                    return Err(bad);
                }
                if value == 0 {
                    Chunk::TrailerStart { total: 0 }
                } else {
                    // A chunk that cannot fit is refused before it is read.
                    let room = self.cap.saturating_sub(self.out.len());
                    if usize::try_from(value).is_ok_and(|v| v <= room) {
                        Chunk::Data { left: value }
                    } else {
                        return Err(FetchError::TooLarge);
                    }
                }
            }
            Chunk::Data { .. } => return Err(bad),
            Chunk::DataCr => {
                if byte != b'\r' {
                    return Err(bad);
                }
                Chunk::DataLf
            }
            Chunk::DataLf => {
                if byte != b'\n' {
                    return Err(bad);
                }
                Chunk::Size { value: 0, seen: 0 }
            }
            Chunk::TrailerStart { total } => match byte {
                b'\r' => Chunk::TrailerEnd,
                b'\n' => return Err(bad),
                _ => Self::trailer(total)?,
            },
            Chunk::Trailer { total } => match byte {
                b'\r' => Chunk::TrailerLf { total },
                b'\n' => return Err(bad),
                _ => Self::trailer(total)?,
            },
            Chunk::TrailerLf { total } => {
                if byte != b'\n' {
                    return Err(bad);
                }
                Chunk::TrailerStart { total }
            }
            Chunk::TrailerEnd => {
                if byte != b'\n' {
                    return Err(bad);
                }
                self.done = true;
                Chunk::Done
            }
            Chunk::Done => Chunk::Done,
        };
        Ok(())
    }

    /// Counts one more trailer byte against [`TRAILER_MAX`].
    fn trailer(total: usize) -> Result<Chunk, FetchError> {
        let total = total.saturating_add(1);
        if total > TRAILER_MAX {
            return Err(FetchError::Network);
        }
        Ok(Chunk::Trailer { total })
    }

    /// The server closed the connection: the body is complete only if its
    /// framing says so.
    fn finish(self) -> Result<Vec<u8>, FetchError> {
        if self.done || self.framing == Framing::Close {
            Ok(self.out)
        } else {
            Err(FetchError::Network)
        }
    }
}

/// The executor's view of the native fetcher: each request owns its future.
impl crate::exec::Fetch for Rc<Fetcher> {
    fn get(&self, path: &str) -> LocalBoxFuture<'static, Result<String, FetchError>> {
        let fetcher = Rc::clone(self);
        let path = path.to_owned();
        async move { Fetcher::get(&fetcher, &path).await }.boxed_local()
    }

    fn post(&self, path: &str, body: &str) -> LocalBoxFuture<'static, Result<String, FetchError>> {
        let fetcher = Rc::clone(self);
        let (path, body) = (path.to_owned(), body.to_owned());
        async move { Fetcher::post(&fetcher, &path, &body).await }.boxed_local()
    }
}

/// Any failure of the exchange itself (not a status, not a size) is "network".
fn net<E>(_: E) -> FetchError {
    FetchError::Network
}

/// What it takes to ask the cloud's HTTP side for history.
pub(crate) struct Fetcher {
    /// Where.
    endpoint: Endpoint,
    /// TLS for `https`.
    tls: TlsConnector,
    /// The bearer token, wiped when the driver goes.
    token: Arc<Zeroizing<String>>,
    /// The whole exchange, connect to last byte.
    limit: Duration,
    /// Longest body accepted.
    cap: usize,
}

impl Fetcher {
    /// A fetcher for `endpoint`; bodies over `cap` bytes are refused.
    pub(crate) fn new(
        endpoint: Endpoint,
        tls: Arc<ClientConfig>,
        token: Arc<Zeroizing<String>>,
        limit: Duration,
        cap: usize,
    ) -> Self {
        Self {
            endpoint,
            tls: TlsConnector::from(tls),
            token,
            limit,
            cap,
        }
    }

    /// `GET <base><path>` with the bearer token: the body of a `200`.
    pub(crate) async fn get(&self, path: &str) -> Result<String, FetchError> {
        timeout(self.limit, self.exchange(path, None))
            .await
            .unwrap_or(Err(FetchError::Network))
    }

    /// `POST <base><path>` with the bearer token and a JSON `body`: the body
    /// of a `200`.
    pub(crate) async fn post(&self, path: &str, body: &str) -> Result<String, FetchError> {
        timeout(self.limit, self.exchange(path, Some(body)))
            .await
            .unwrap_or(Err(FetchError::Network))
    }

    /// Connects (and negotiates TLS when `https`), then runs the exchange.
    async fn exchange(&self, path: &str, body: Option<&str>) -> Result<String, FetchError> {
        let tcp = TcpStream::connect((self.endpoint.host.as_str(), self.endpoint.port))
            .await
            .map_err(net)?;
        // Best effort: it only trims a little latency off one small request.
        let _ = tcp.set_nodelay(true);
        if self.endpoint.tls {
            let name = ServerName::try_from(self.endpoint.host.clone()).map_err(net)?;
            let stream = self.tls.connect(name, tcp).await.map_err(net)?;
            self.converse(stream, path, body).await
        } else {
            self.converse(tcp, path, body).await
        }
    }

    /// Writes the request and reads the answer.
    async fn converse<S>(
        &self,
        mut stream: S,
        path: &str,
        body: Option<&str>,
    ) -> Result<String, FetchError>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        {
            let request = self.endpoint.request(path, self.token.as_str(), body);
            stream.write_all(&request).await.map_err(net)?;
            stream.flush().await.map_err(net)?;
        }
        let mut chunk = vec![0u8; READ_BUF];
        let mut head_bytes: Vec<u8> = Vec::with_capacity(1024);
        let (head, used) = loop {
            if let Some(parsed) = parse_head(&head_bytes).map_err(net)? {
                break parsed;
            }
            if head_bytes.len() >= HEAD_MAX {
                return Err(FetchError::Network);
            }
            let read = stream.read(&mut chunk).await.map_err(net)?;
            if read == 0 {
                return Err(FetchError::Network);
            }
            head_bytes.extend_from_slice(chunk.get(..read).ok_or(FetchError::Network)?);
        };
        let early = head_bytes.get(used..).ok_or(FetchError::Network)?;
        if head.status != 200 {
            // The refusal's own words, when it says them in a small JSON body:
            // a failure to read them is only a refusal without a name.
            let refusal = read_body(
                &mut stream,
                &mut chunk,
                head.framing,
                early,
                REFUSAL_BODY_MAX,
            )
            .await
            .ok()
            .and_then(|body| refusal_in(&body));
            return Err(FetchError::Status(head.status, refusal));
        }
        let body = read_body(&mut stream, &mut chunk, head.framing, early, self.cap).await?;
        String::from_utf8(body).map_err(net)
    }
}

/// Longest refusal body read for its `error` code: the server's are a line.
const REFUSAL_BODY_MAX: usize = 4096;

/// Reads a body framed as `framing`, starting with the `early` bytes that came
/// with the head, and never past `cap`.
async fn read_body<S>(
    stream: &mut S,
    chunk: &mut [u8],
    framing: Framing,
    early: &[u8],
    cap: usize,
) -> Result<Vec<u8>, FetchError>
where
    S: AsyncRead + Unpin,
{
    let mut body = Body::new(framing, cap)?;
    body.feed(early)?;
    while !body.done {
        let read = stream.read(chunk).await.map_err(net)?;
        if read == 0 {
            break;
        }
        body.feed(chunk.get(..read).ok_or(FetchError::Network)?)?;
    }
    body.finish()
}

/// The refusal named by `{"error":"<code>", …}`, without a JSON parser: the
/// code is a bare lowercase word, and anything else is no name at all.
fn refusal_in(body: &[u8]) -> Option<Refusal> {
    let text = std::str::from_utf8(body).ok()?;
    let after_key = &text[text.find("\"error\"")? + "\"error\"".len()..];
    let after_colon = after_key.trim_start().strip_prefix(':')?.trim_start();
    let value = after_colon.strip_prefix('"')?;
    let code = &value[..value.find('"')?];
    Refusal::from_code(code)
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::net::SocketAddr;

    use tokio::net::TcpListener;

    use super::*;

    /// A chunked encoding of `parts`, with an extension and a trailer.
    fn chunked(parts: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for part in parts {
            write!(out, "{:x};ext=1\r\n", part.len()).unwrap();
            out.extend_from_slice(part);
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"0\r\nX-Trailer: yes\r\n\r\n");
        out
    }

    fn decode(framing: Framing, cap: usize, pieces: &[&[u8]]) -> Result<Vec<u8>, FetchError> {
        let mut body = Body::new(framing, cap)?;
        for piece in pieces {
            body.feed(piece)?;
        }
        body.finish()
    }

    #[test]
    fn chunked_body_is_the_same_whatever_the_read_boundaries() {
        let wire = chunked(&[b"hello ", b"wor", b"ld", &[b'x'; 300]]);
        let mut expected = b"hello world".to_vec();
        expected.extend_from_slice(&[b'x'; 300]);
        for size in 1..=wire.len() {
            let pieces: Vec<&[u8]> = wire.chunks(size).collect();
            assert_eq!(
                decode(Framing::Chunked, 1 << 20, &pieces),
                Ok(expected.clone()),
                "read size {size}"
            );
        }
    }

    #[test]
    fn chunked_body_without_its_last_chunk_is_a_truncation() {
        let mut wire = chunked(&[b"abc"]);
        wire.truncate(wire.len() - 5);
        assert_eq!(
            decode(Framing::Chunked, 1 << 20, &[&wire]),
            Err(FetchError::Network)
        );
    }

    #[test]
    fn chunked_grammar_is_strict() {
        for wire in [
            &b"3\nabc\r\n0\r\n\r\n"[..],    // bare LF after the size
            b"3\r\nabcX\r\n0\r\n\r\n",      // data longer than its size
            b"3\r\nabc\r\n\r\n0\r\n\r\n",   // missing size line
            b"zz\r\nabc\r\n0\r\n\r\n",      // not hex
            b"\r\nabc\r\n0\r\n\r\n",        // no digits
            b"3\r\nabc\r\n0\r\nT: v\n\r\n", // bare LF in a trailer
            b"fffffffffffffffff\r\n",       // 17 digits
        ] {
            assert_eq!(
                decode(Framing::Chunked, 1 << 20, &[wire]),
                Err(FetchError::Network),
                "{:?}",
                String::from_utf8_lossy(wire)
            );
        }
    }

    #[test]
    fn chunked_trailer_is_bounded() {
        let mut wire = b"0\r\n".to_vec();
        wire.extend_from_slice(b"T: ");
        wire.extend(std::iter::repeat_n(b'a', TRAILER_MAX + 10));
        wire.extend_from_slice(b"\r\n\r\n");
        assert_eq!(
            decode(Framing::Chunked, 1 << 20, &[&wire]),
            Err(FetchError::Network)
        );
    }

    #[test]
    fn cap_is_enforced_for_every_framing() {
        // Declared length over the cap: refused before any body byte.
        assert_eq!(
            decode(Framing::Length(11), 10, &[]),
            Err(FetchError::TooLarge)
        );
        // Exactly the cap is fine.
        assert_eq!(
            decode(Framing::Length(10), 10, &[b"0123456789"]),
            Ok(b"0123456789".to_vec())
        );
        // A chunk that announces more than the room left: refused unread.
        let mut body = Body::new(Framing::Chunked, 10).unwrap();
        assert_eq!(body.feed(b"b\r\n"), Err(FetchError::TooLarge));
        // Chunks that add up past the cap.
        assert_eq!(
            decode(
                Framing::Chunked,
                10,
                &[b"6\r\nabcdef\r\n6\r\nabcdef\r\n0\r\n\r\n"]
            ),
            Err(FetchError::TooLarge)
        );
        // No framing at all: counted as it arrives.
        assert_eq!(
            decode(Framing::Close, 10, &[b"01234", b"56789", b"x"]),
            Err(FetchError::TooLarge)
        );
        assert_eq!(
            decode(Framing::Close, 10, &[b"01234", b"56789"]),
            Ok(b"0123456789".to_vec())
        );
    }

    #[test]
    fn short_fixed_length_body_is_a_truncation() {
        assert_eq!(
            decode(Framing::Length(5), 100, &[b"abc"]),
            Err(FetchError::Network)
        );
        assert_eq!(decode(Framing::Length(0), 100, &[]), Ok(Vec::new()));
    }

    #[test]
    fn head_framing_and_refusals() {
        let head = |raw: &str| parse_head(raw.as_bytes());
        assert_eq!(head("HTTP/1.1 200 OK\r\nContent-Le"), Ok(None));
        assert_eq!(
            head("HTTP/1.1 200 OK\r\ncontent-length: 12\r\n\r\nbody"),
            Ok(Some((
                Head {
                    status: 200,
                    framing: Framing::Length(12)
                },
                "HTTP/1.1 200 OK\r\ncontent-length: 12\r\n\r\n".len()
            )))
        );
        assert_eq!(
            head("HTTP/1.1 200 OK\r\nTransfer-Encoding: Chunked\r\nContent-Length: 9\r\n\r\n")
                .map(|h| h.map(|(h, _)| h.framing)),
            Ok(Some(Framing::Chunked))
        );
        assert_eq!(
            head("HTTP/1.0 200 OK\r\n\r\n").map(|h| h.map(|(h, _)| h.framing)),
            Ok(Some(Framing::Close))
        );
        assert_eq!(
            head("HTTP/1.1 404 Not Found\r\n\r\n").map(|h| h.map(|(h, _)| h.status)),
            Ok(Some(404))
        );
        for refused in [
            "HTTP/1.1 100 Continue\r\n\r\n",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Length: 99999999999999999999\r\n\r\n",
            "garbage\r\n\r\n",
        ] {
            assert_eq!(head(refused), Err(Malformed), "{refused}");
        }
        assert_eq!(
            head("HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\n")
                .map(|h| h.map(|(h, _)| h.framing)),
            Ok(Some(Framing::Length(1)))
        );
        assert_eq!(
            head("HTTP/1.1 200 OK\r\nContent-Encoding: identity\r\nContent-Length: 0\r\n\r\n")
                .map(|h| h.map(|(h, _)| h.framing)),
            Ok(Some(Framing::Length(0)))
        );
    }

    #[test]
    fn endpoint_parsing() {
        let e = Endpoint::parse("http://127.0.0.1:7699/tailchat").unwrap();
        assert_eq!(
            (
                e.tls,
                e.host.as_str(),
                e.port,
                e.authority.as_str(),
                e.prefix.as_str()
            ),
            (false, "127.0.0.1", 7699, "127.0.0.1:7699", "/tailchat")
        );
        let e = Endpoint::parse("https://chat.example.org/").unwrap();
        assert_eq!(
            (
                e.tls,
                e.host.as_str(),
                e.port,
                e.authority.as_str(),
                e.prefix.as_str()
            ),
            (true, "chat.example.org", 443, "chat.example.org", "")
        );
        let e = Endpoint::parse("http://[::1]:8080/p/q/").unwrap();
        assert_eq!(
            (
                e.host.as_str(),
                e.port,
                e.authority.as_str(),
                e.prefix.as_str()
            ),
            ("::1", 8080, "[::1]:8080", "/p/q")
        );
        for refused in [
            "ws://127.0.0.1/x",
            "ftp://h/",
            "127.0.0.1:7699/x",
            "/relative",
            "http://user:pw@h/",
            "http://h/?q=1",
            "http://h/#frag",
            "http:///nohost",
            "",
        ] {
            assert_eq!(Endpoint::parse(refused), None, "{refused}");
        }
    }

    #[test]
    fn request_text() {
        let endpoint = Endpoint::parse("http://127.0.0.1:7699/tailchat").unwrap();
        let request = endpoint.request("/api/history?peer=bob&limit=200", &"ab".repeat(32), None);
        let text = String::from_utf8(request.to_vec()).unwrap();
        let lines: Vec<&str> = text.split("\r\n").collect();
        assert_eq!(
            lines[0],
            "GET /tailchat/api/history?peer=bob&limit=200 HTTP/1.1"
        );
        assert!(lines.contains(&"Host: 127.0.0.1:7699"));
        assert!(lines.contains(&format!("Authorization: Bearer {}", "ab".repeat(32)).as_str()));
        assert!(lines.contains(&"Accept-Encoding: identity"));
        assert!(lines.contains(&"Connection: close"));
        assert!(text.ends_with("\r\n\r\n"));
    }

    #[test]
    fn post_request_text_carries_a_json_body_with_its_length() {
        let endpoint = Endpoint::parse("http://127.0.0.1:7699/tailchat").unwrap();
        let body = r#"{"logins":["bob","ёж"]}"#;
        let request = endpoint.request("/api/e2ee/keys/query", &"ab".repeat(32), Some(body));
        let text = String::from_utf8(request.to_vec()).unwrap();
        let (head, sent) = text.split_once("\r\n\r\n").unwrap();
        let lines: Vec<&str> = head.split("\r\n").collect();
        assert_eq!(lines[0], "POST /tailchat/api/e2ee/keys/query HTTP/1.1");
        assert!(lines.contains(&"Content-Type: application/json"));
        // Bytes, not characters: `ё` and `ж` are two bytes each.
        assert!(lines.contains(&format!("Content-Length: {}", body.len()).as_str()));
        assert!(lines.contains(&"Connection: close"));
        assert_eq!(sent, body);
    }

    /// One scripted answer from a one-shot loopback server; the request it saw
    /// comes back through the join handle.
    async fn serve(
        script: impl FnOnce(tokio::net::TcpStream) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send>>
        + Send
        + 'static,
    ) -> (SocketAddr, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 1024];
            while !seen.ends_with(b"\r\n\r\n") {
                let n = stream.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                seen.extend_from_slice(&buf[..n]);
            }
            script(stream).await;
            String::from_utf8(seen).unwrap()
        });
        (addr, task)
    }

    fn fetcher(addr: SocketAddr, cap: usize, limit: Duration) -> Fetcher {
        let tls = crate::tls::config().unwrap();
        Fetcher::new(
            Endpoint::parse(&format!("http://{addr}/pre")).unwrap(),
            tls,
            Arc::new(Zeroizing::new("cd".repeat(32))),
            limit,
            cap,
        )
    }

    fn reply(
        bytes: &'static [u8],
    ) -> impl FnOnce(tokio::net::TcpStream) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send>>
    + Send
    + 'static {
        move |mut stream| {
            Box::pin(async move {
                stream.write_all(bytes).await.unwrap();
                stream.shutdown().await.unwrap();
            })
        }
    }

    const LONG: Duration = Duration::from_secs(10);

    #[tokio::test(flavor = "current_thread")]
    async fn get_sends_the_token_and_returns_a_content_length_body() {
        let (addr, seen) = serve(reply(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}",
        ))
        .await;
        let body = fetcher(addr, 1 << 20, LONG)
            .get("/api/history?peer=bob")
            .await;
        assert_eq!(body, Ok("{\"ok\":true}".to_owned()));
        let request = seen.await.unwrap();
        assert!(request.starts_with("GET /pre/api/history?peer=bob HTTP/1.1\r\n"));
        assert!(request.contains(&format!("Authorization: Bearer {}\r\n", "cd".repeat(32))));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn get_reads_a_chunked_body_and_one_that_ends_at_close() {
        let (addr, _) = serve(reply(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6;x=y\r\n world\r\n0\r\n\r\n",
        ))
        .await;
        assert_eq!(
            fetcher(addr, 1 << 20, LONG).get("/x").await,
            Ok("hello world".to_owned())
        );
        let (addr, _) = serve(reply(b"HTTP/1.0 200 OK\r\n\r\nuntil close")).await;
        assert_eq!(
            fetcher(addr, 1 << 20, LONG).get("/x").await,
            Ok("until close".to_owned())
        );
    }

    #[test]
    fn a_refusal_is_named_only_by_a_code_the_core_acts_on() {
        let named = br#"{"error":"device_keys_changed","message":"...","deviceId":"X"}"#;
        assert_eq!(refusal_in(named), Some(Refusal::DeviceKeysChanged));
        assert_eq!(
            refusal_in(br#"{ "error" : "device_keys_changed" }"#),
            Some(Refusal::DeviceKeysChanged)
        );
        for other in [
            &br#"{"error":"device_limit"}"#[..],
            br#"{"error":42}"#,
            br#"{"message":"device_keys_changed"}"#,
            b"<html>bad gateway</html>",
            b"",
            &[0xff, 0xfe][..],
        ] {
            assert_eq!(refusal_in(other), None, "{other:?}");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_refusal_carries_the_server_code_beside_its_status() {
        // `get` and `post` share `converse`, which reads the refusal; the test
        // server here stops reading at the blank line, so a GET it is.
        let body = br#"{"error":"device_keys_changed","message":"keys","deviceId":"D"}"#;
        let mut answer = format!(
            "HTTP/1.1 409 Conflict\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        answer.extend_from_slice(body);
        let (addr, _) = serve(reply(Box::leak(answer.into_boxed_slice()))).await;
        assert_eq!(
            fetcher(addr, 1 << 20, LONG).get("/x").await,
            Err(FetchError::Status(409, Some(Refusal::DeviceKeysChanged)))
        );
        // A refusal body larger than the small cap is still a refusal, unnamed.
        let mut big = format!(
            "HTTP/1.1 409 Conflict\r\nContent-Length: {}\r\n\r\n",
            10_000
        )
        .into_bytes();
        big.extend(std::iter::repeat_n(b' ', 10_000));
        let (addr, _) = serve(reply(Box::leak(big.into_boxed_slice()))).await;
        assert_eq!(
            fetcher(addr, 1 << 20, LONG).get("/x").await,
            Err(FetchError::Status(409, None))
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn get_maps_status_truncation_and_garbage() {
        let (addr, _) = serve(reply(
            b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n",
        ))
        .await;
        assert_eq!(
            fetcher(addr, 1 << 20, LONG).get("/x").await,
            Err(FetchError::Status(403, None))
        );
        let (addr, _) = serve(reply(b"HTTP/1.1 503 Busy\r\n\r\nupstream down")).await;
        assert_eq!(
            fetcher(addr, 1 << 20, LONG).get("/x").await,
            Err(FetchError::Status(503, None))
        );
        // Closed after 3 of 10 promised bytes.
        let (addr, _) = serve(reply(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc")).await;
        assert_eq!(
            fetcher(addr, 1 << 20, LONG).get("/x").await,
            Err(FetchError::Network)
        );
        // Closed before the head is complete.
        let (addr, _) = serve(reply(b"HTTP/1.1 200 OK\r\nContent-")).await;
        assert_eq!(
            fetcher(addr, 1 << 20, LONG).get("/x").await,
            Err(FetchError::Network)
        );
        // Not UTF-8.
        let (addr, _) = serve(reply(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n\xff\xfe",
        ))
        .await;
        assert_eq!(
            fetcher(addr, 1 << 20, LONG).get("/x").await,
            Err(FetchError::Network)
        );
        // Nothing listening.
        let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = dead.local_addr().unwrap();
        drop(dead);
        assert_eq!(
            fetcher(addr, 1 << 20, LONG).get("/x").await,
            Err(FetchError::Network)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn get_gives_up_on_a_server_that_goes_quiet() {
        let (addr, _) = serve(|stream| {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_secs(30)).await;
                drop(stream);
            })
        })
        .await;
        let started = std::time::Instant::now();
        assert_eq!(
            fetcher(addr, 1 << 20, Duration::from_millis(200))
                .get("/x")
                .await,
            Err(FetchError::Network)
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn declared_oversize_body_is_refused_without_reading_it() {
        // The server promises the cap plus one byte and then stalls: the
        // fetcher must answer from the head alone.
        let (addr, _) = serve(|mut stream| {
            Box::pin(async move {
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                    tailchat_core::MAX_INBOUND + 1
                );
                stream.write_all(head.as_bytes()).await.unwrap();
                tokio::time::sleep(Duration::from_secs(30)).await;
            })
        })
        .await;
        let started = std::time::Instant::now();
        assert_eq!(
            fetcher(addr, tailchat_core::MAX_INBOUND, LONG)
                .get("/x")
                .await,
            Err(FetchError::TooLarge)
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn streamed_body_is_cut_at_max_inbound() {
        // Chunked with no end: the fetcher stops reading once the cap is
        // passed, long before the server runs out of data.
        let (addr, _) = serve(|mut stream| {
            Box::pin(async move {
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                    .await
                    .unwrap();
                let block = vec![b'a'; 1 << 20];
                let frame = {
                    let mut frame = format!("{:x}\r\n", block.len()).into_bytes();
                    frame.extend_from_slice(&block);
                    frame.extend_from_slice(b"\r\n");
                    frame
                };
                // 41 MiB would be endless to the fetcher: it must hang up
                // after 40 MiB + 4 KiB, so writes start failing.
                for _ in 0..(tailchat_core::MAX_INBOUND / (1 << 20) + 8) {
                    if stream.write_all(&frame).await.is_err() {
                        return;
                    }
                }
            })
        })
        .await;
        assert_eq!(
            fetcher(addr, tailchat_core::MAX_INBOUND, LONG)
                .get("/x")
                .await,
            Err(FetchError::TooLarge)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn body_of_exactly_the_cap_is_accepted() {
        let (addr, _) = serve(|mut stream| {
            Box::pin(async move {
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n")
                    .await
                    .unwrap();
                stream.write_all(&[b'z'; 64]).await.unwrap();
                stream.shutdown().await.unwrap();
            })
        })
        .await;
        assert_eq!(fetcher(addr, 64, LONG).get("/x").await, Ok("z".repeat(64)));
    }
}
