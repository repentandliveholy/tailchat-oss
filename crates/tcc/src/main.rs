//! `tcc` — a terminal client for Tailchat cloud.
//!
//! ```text
//! tcc [login]                  the chat screen (opens on a conversation)
//! tcc login [server]           sign in with a password
//! tcc logout                   forget what `tcc login` saved
//! tcc who                      the roster, once
//! tcc send <login> [text…]     one message (text from stdin when omitted)
//! ```
//!
//! It speaks the cloud's own WebSocket protocol and keeps nothing on disk but
//! the token `tcc login` saves (`~/.tailchat/tcc.json`, mode 0600). The token
//! is never printed.

mod creds;
mod gallery;
mod media;
mod model;
mod net;
mod text;
mod ui;

use std::collections::VecDeque;
use std::ffi::OsString;
use std::hash::{BuildHasher as _, RandomState};
use std::io::{BufRead as _, IsTerminal as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, Event,
    EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent,
    MouseEventKind,
};
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use futures_util::StreamExt as _;
use gallery::Gallery;
use image::DynamicImage;
use model::{Effect, HISTORY_LIMIT, LinkState, Model};
use net::{Endpoints, Link, Net, Sent};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use serde_json::{Value, json};
use text::{Input, login_of};
use tokio::sync::mpsc;
use tokio::time::{Instant, MissedTickBehavior, interval, sleep_until};

/// Reads are reported once per burst, not once per message.
const READ_DEBOUNCE: Duration = Duration::from_millis(300);
/// How long `tcc send` and `tcc who` wait for the server before giving up.
const ONE_SHOT: Duration = Duration::from_secs(30);

const USAGE: &str = "\
tcc: a terminal client for Tailchat cloud

usage:
  tcc [login]               open the chat screen (on a conversation, if named)
  tcc login [server]        sign in with a password and remember the token
  tcc logout                forget the token `tcc login` saved
  tcc who                   print the roster and exit
  tcc send <login> [text]   send one message and exit (stdin if no text)

  -s, --server <url>        server for this run (else TCC_SERVER, the saved one,
                            the full client's, repentandliveholy.org)
  -h, --help   -V, --version

The token comes from TCC_TOKEN, `tcc login`, or the full client's login in
~/.tailchat. In the chat screen /help lists the commands. A contact named like
a command (`who`) is opened as `tcc @who`.";

// ── arguments ───────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Chat(Option<String>),
    Login,
    Logout,
    Who,
    Send { peer: String, text: Option<String> },
    Help,
    Version,
}

#[derive(Debug, PartialEq, Eq)]
struct Args {
    command: Command,
    server: Option<String>,
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut server = None;
    let mut words = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(Args { command: Command::Help, server }),
            "-V" | "--version" => return Ok(Args { command: Command::Version, server }),
            "-s" | "--server" => {
                server = Some(iter.next().ok_or("--server needs an address")?.clone());
            }
            flag if flag.starts_with('-') && flag.len() > 1 => {
                return Err(format!("unknown option {flag}"));
            }
            _ => words.push(arg.clone()),
        }
    }
    let mut words = words.into_iter();
    let first = words.next();
    let rest: Vec<String> = words.collect();
    let command = match first.as_deref() {
        None => Command::Chat(None),
        Some("help") => Command::Help,
        Some("login") if rest.len() <= 1 => {
            server = server.or_else(|| rest.first().cloned());
            Command::Login
        }
        Some("logout") if rest.is_empty() => Command::Logout,
        Some("who") if rest.is_empty() => Command::Who,
        Some("send") => {
            let peer = rest.first().map(|p| login_of(p)).filter(|p| !p.is_empty());
            let peer = peer.ok_or("usage: tcc send <login> [text]")?;
            let text = (rest.len() > 1).then(|| rest.get(1..).unwrap_or(&[]).join(" "));
            Command::Send { peer, text }
        }
        Some(login) if rest.is_empty() => Command::Chat(Some(login_of(login))),
        Some(other) => return Err(format!("unexpected arguments after {other}")),
    };
    Ok(Args { command, server })
}

// ── small facts ─────────────────────────────────────────────────────────────

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// The home directory: `HOME`, or on Windows (which has none) `USERPROFILE`.
fn home_from(home: Option<OsString>, profile: Option<OsString>) -> Option<PathBuf> {
    home.filter(|h| !h.is_empty())
        .or(profile.filter(|p| !p.is_empty()))
        .map(PathBuf::from)
}

fn home_dir() -> Option<PathBuf> {
    home_from(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"))
}

/// `~/.tailchat`, where the full client keeps its state too.
fn state_dir_from(home: Option<OsString>, profile: Option<OsString>) -> Option<PathBuf> {
    home_from(home, profile).map(|dir| dir.join(".tailchat"))
}

fn state_dir() -> Option<PathBuf> {
    state_dir_from(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|since| i64::try_from(since.as_millis()).ok())
        .unwrap_or(0)
}

/// `m-` + 32 hex, the web client's shape. The server only wants a unique
/// non-empty string, so the clock plus two draws from the OS-seeded hasher do.
fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let a = RandomState::new().hash_one((nanos, n, 0u8));
    let b = RandomState::new().hash_one((nanos, n, 1u8));
    format!("m-{a:016x}{b:016x}")
}

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    // A closed pipe must not turn into a panic; there is nobody to tell.
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn fail(reason: &str) -> ExitCode {
    eprintln!("tcc: {reason}");
    ExitCode::FAILURE
}

/// Where to connect and as whom.
struct Session {
    endpoints: Endpoints,
    token: String,
}

fn session(server_flag: Option<String>) -> Result<Session, String> {
    let dir = state_dir();
    let creds = creds::load(env, dir.as_deref())
        .ok_or("not signed in: run `tcc login` (or set TCC_TOKEN)")?;
    let server = server_flag.unwrap_or_else(|| creds::server(env, creds.server.as_deref()));
    let endpoints =
        Endpoints::parse(&server).ok_or_else(|| format!("unusable server address: {server}"))?;
    Ok(Session {
        endpoints,
        token: creds.token,
    })
}

// ── login / logout ──────────────────────────────────────────────────────────

/// A line from the terminal; the password is not echoed.
fn prompt(label: &str, hidden: bool) -> Option<String> {
    eprint!("{label}");
    let _ = std::io::stderr().flush();
    if !hidden || !std::io::stdin().is_terminal() {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line).ok()?;
        return Some(line.trim_end_matches(['\r', '\n']).to_owned());
    }
    enable_raw_mode().ok()?;
    let mut typed = String::new();
    let result = loop {
        match crossterm::event::read() {
            Ok(Event::Key(key)) if key.kind != KeyEventKind::Release => {
                let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
                match key.code {
                    KeyCode::Enter => break Some(typed),
                    KeyCode::Char('c' | 'd') if ctrl => break None,
                    KeyCode::Char(c) if !ctrl => typed.push(c),
                    KeyCode::Backspace => {
                        typed.pop();
                    }
                    _ => {}
                }
            }
            Ok(_) => {}
            Err(_) => break None,
        }
    };
    let _ = disable_raw_mode();
    eprintln!();
    result
}

fn cmd_login(server_flag: Option<String>) -> ExitCode {
    let Some(dir) = state_dir() else {
        return fail("no home directory");
    };
    let server = server_flag
        .unwrap_or_else(|| creds::server(env, creds::config_server(Some(&dir)).as_deref()));
    let Some(endpoints) = Endpoints::parse(&server) else {
        return fail(&format!("unusable server address: {server}"));
    };
    let Some(login) = prompt(&format!("login on {server}: "), false).map(|l| login_of(&l)) else {
        return fail("cancelled");
    };
    let Some(password) = prompt("password: ", true) else {
        return fail("cancelled");
    };
    let url = format!("{}/login", endpoints.api);
    let mut extra: Option<String> = None;
    let token = loop {
        let body = match &extra {
            Some(extra) => json!({"login": login, "password": password, "extraPassword": extra}),
            None => json!({"login": login, "password": password}),
        };
        let reply = match net::call("POST", &url, None, Some(&body)) {
            Ok(reply) => reply,
            Err(error) => return fail(&format!("cannot reach the server: {error}")),
        };
        if reply.ok() {
            match reply.body.get("token").and_then(Value::as_str) {
                Some(token) => break token.to_owned(),
                None => return fail("the server sent no token"),
            }
        }
        match reply.code().as_str() {
            "extra_password_required" if extra.is_none() => {
                let Some(second) = prompt("second password: ", true) else {
                    return fail("cancelled");
                };
                extra = Some(second);
            }
            "bad_credentials" | "extra_password_required" => return fail("wrong login or password"),
            "too_many_attempts" => return fail("too many attempts: wait a little"),
            other => return fail(&format!("sign-in refused: {other}")),
        }
    };
    if let Err(error) = creds::save(&dir, &server, &token) {
        return fail(&format!("signed in, but the token could not be saved: {error}"));
    }
    say(&format!("signed in as @{login} on {server}"));
    ExitCode::SUCCESS
}

fn cmd_logout() -> ExitCode {
    let Some(dir) = state_dir() else {
        return fail("no home directory");
    };
    let Some((server, token)) = creds::forget(&dir) else {
        say("nothing saved by `tcc login` (a token from the full client is left alone)");
        return ExitCode::SUCCESS;
    };
    // Revoke it on the server too; if that fails the token is still forgotten here.
    let revoked = Endpoints::parse(&server)
        .and_then(|ep| net::call("POST", &format!("{}/logout", ep.api), Some(&token), None).ok())
        .is_some_and(|reply| reply.ok());
    say(if revoked {
        "signed out"
    } else {
        "forgotten here; the server could not be reached to revoke it"
    });
    ExitCode::SUCCESS
}

// ── one-shot: who, send ─────────────────────────────────────────────────────

enum Job {
    Who,
    Send { peer: String, lines: Vec<String> },
}

/// Connects, does the one thing, reports, leaves.
async fn run_job(session: Session, job: Job) -> ExitCode {
    let tls = match net::tls_config() {
        Ok(tls) => tls,
        Err(error) => return fail(&format!("TLS setup failed: {error}")),
    };
    let mut model = Model::new(None, false, now_ms, new_id);
    let mut link = Link::new();
    let deadline = Instant::now() + ONE_SHOT;
    let mut sent = false;
    let mut last_error = String::from("timed out");
    loop {
        let retry_at = link.retry_at;
        let up = link.is_up();
        enum Step {
            Net(Net),
            Dial,
            Timeout,
        }
        let step = tokio::select! {
            net = link.recv() => Step::Net(net),
            () = sleep_until(retry_at), if !up => Step::Dial,
            () = sleep_until(deadline) => Step::Timeout,
        };
        match step {
            Step::Timeout => return fail(&last_error),
            Step::Dial => {
                if let Err(error) = link.dial(&session.endpoints, &tls, &session.token).await {
                    last_error = format!("cannot connect: {error}");
                    link.lost();
                }
            }
            Step::Net(Net::Lost) => {
                last_error = "connection lost".to_owned();
                link.lost();
            }
            Step::Net(Net::Text(text)) => {
                let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let mut effects = model.on_server(&frame);
                if model.link == LinkState::Online {
                    link.settled();
                    if !sent {
                        sent = true;
                        match &job {
                            Job::Who => {
                                for c in model.sorted() {
                                    let lamp = if c.online { "● online" } else { "○ away" };
                                    let unread = if c.pending > 0 {
                                        format!("  {} new", c.pending)
                                    } else {
                                        String::new()
                                    };
                                    say(&format!("@{} {lamp}{unread}  {}", c.login, c.title()));
                                }
                                link.close().await;
                                return ExitCode::SUCCESS;
                            }
                            Job::Send { peer, lines } => {
                                if model.contact(peer).is_none() {
                                    link.close().await;
                                    return fail(&format!("@{peer} is not one of your contacts"));
                                }
                                for line in lines {
                                    effects.extend(model.send_text(peer, line));
                                }
                            }
                        }
                    }
                }
                for effect in effects {
                    match effect {
                        Effect::Send(frame) => {
                            if link.send(&frame).await == Sent::Broken {
                                link.lost();
                            }
                        }
                        Effect::Fatal(reason) => return fail(&reason),
                        Effect::History(_)
                        | Effect::Bell
                        | Effect::Quit
                        | Effect::Open(_)
                        | Effect::LoadImage { .. } => {}
                    }
                }
                if let Some((status, _)) = &model.status {
                    last_error.clone_from(status);
                }
                if sent && model.failed() > 0 {
                    link.close().await;
                    return fail(&last_error);
                }
                if sent && model.unconfirmed() == 0 {
                    if let Job::Send { peer, lines } = &job {
                        say(&format!("✓ {} message(s) sent to @{peer}", lines.len()));
                    }
                    link.close().await;
                    return ExitCode::SUCCESS;
                }
            }
        }
    }
}

fn cmd_job(server: Option<String>, job: Job) -> ExitCode {
    let session = match session(server) {
        Ok(session) => session,
        Err(reason) => return fail(&reason),
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => return fail(&format!("cannot start the runtime: {error}")),
    };
    let code = runtime.block_on(run_job(session, job));
    runtime.shutdown_background();
    code
}

// ── the chat screen ─────────────────────────────────────────────────────────

/// Raw mode and the alternate screen, put back however the program ends.
fn restore_terminal() {
    let _ = disable_raw_mode();
    let _ = crossterm::execute!(
        std::io::stdout(),
        DisableBracketedPaste,
        DisableMouseCapture,
        LeaveAlternateScreen,
        crossterm::cursor::Show
    );
}

struct Screen {
    terminal: Terminal<CrosstermBackend<std::io::Stdout>>,
}

impl Screen {
    fn enter() -> std::io::Result<Self> {
        enable_raw_mode()?;
        let mut out = std::io::stdout();
        if let Err(error) = crossterm::execute!(out, EnterAlternateScreen) {
            restore_terminal();
            return Err(error);
        }
        // Not every terminal can (the legacy Windows console cannot); without
        // it a paste arrives as typed characters, which works as well.
        let _ = crossterm::execute!(out, EnableBracketedPaste, EnableMouseCapture);
        // Turn off any-event tracking (?1003) so mouse movement does not redraw each frame.
        let _ = crossterm::execute!(out, crossterm::style::Print("\x1b[?1003l"));
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            restore_terminal();
            default_hook(info);
        }));
        Terminal::new(CrosstermBackend::new(out)).map(|terminal| Self { terminal })
    }

    /// Renders a frame using Synchronized Output (DEC mode 2026).
    /// The terminal buffers all draw operations (including \x1b[2J clear on resize)
    /// and flips atomically to the screen, eliminating flicker during resize.
    fn draw<F>(&mut self, f: F) -> std::io::Result<()>
    where
        F: FnOnce(&mut ratatui::Frame),
    {
        use std::io::Write as _;
        use crossterm::QueueableCommand as _;
        use crossterm::terminal::{BeginSynchronizedUpdate, EndSynchronizedUpdate};

        let _ = self.terminal.backend_mut().queue(BeginSynchronizedUpdate);
        let _ = self.terminal.backend_mut().flush();
        let result = self.terminal.draw(f).map(|_| ());
        let _ = self.terminal.backend_mut().queue(EndSynchronizedUpdate);
        let _ = self.terminal.backend_mut().flush();
        result
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        restore_terminal();
    }
}

/// How the program ends.
enum Done {
    Quit,
    Fatal(String),
}

/// Scrolls the open conversation by `delta` lines (positive: up).
fn scroll(model: &mut Model, delta: isize) {
    let Some(conv) = model.current.clone().and_then(|p| model.convs.get_mut(&p)) else {
        return;
    };
    let step = delta.unsigned_abs();
    conv.scroll = if delta > 0 {
        conv.scroll.saturating_add(step)
    } else {
        conv.scroll.saturating_sub(step)
    };
    if conv.scroll == 0 {
        conv.unseen = 0;
    }
}

fn apply_scroll_track(mouse_row: u16, term_h: u16, model: &mut Model) {
    let track_height = term_h.saturating_sub(4);
    if track_height > 0 {
        let click_y = usize::from(mouse_row.saturating_sub(1));
        let th = usize::from(track_height);
        if let Some(peer) = model.current.clone()
            && let Some(conv) = model.convs.get_mut(&peer)
        {
            let max_scroll = conv.max_scroll;
            if max_scroll > 0 {
                let inv_y = th.saturating_sub(click_y.min(th));
                conv.scroll = (inv_y * max_scroll) / th.max(1);
                if conv.scroll == 0 {
                    conv.unseen = 0;
                }
            }
        }
    }
}

fn on_mouse(mouse: MouseEvent, model: &mut Model, dragging: &mut bool) -> Vec<Effect> {
    match mouse.kind {
        MouseEventKind::ScrollUp => {
            let width = crossterm::terminal::size().map_or(80, |(w, _)| w);
            if width >= ui::SIDEBAR_MIN_SCREEN && mouse.column < ui::SIDEBAR {
                model.cycle(-1)
            } else {
                let delta = if mouse.modifiers.contains(KeyModifiers::SHIFT) { 8 } else { 3 };
                scroll(model, delta);
                Vec::new()
            }
        }
        MouseEventKind::ScrollDown => {
            let width = crossterm::terminal::size().map_or(80, |(w, _)| w);
            if width >= ui::SIDEBAR_MIN_SCREEN && mouse.column < ui::SIDEBAR {
                model.cycle(1)
            } else {
                let delta = if mouse.modifiers.contains(KeyModifiers::SHIFT) { 8 } else { 3 };
                scroll(model, -delta);
                Vec::new()
            }
        }
        MouseEventKind::Down(MouseButton::Left) => {
            let (term_w, term_h) = crossterm::terminal::size().unwrap_or((80, 24));
            if term_w >= ui::SIDEBAR_MIN_SCREEN
                && mouse.column < ui::SIDEBAR
                && (2..term_h.saturating_sub(1)).contains(&mouse.row)
            {
                let sorted = model.sorted();
                let at = sorted
                    .iter()
                    .position(|c| model.current.as_deref() == Some(c.login.as_str()))
                    .unwrap_or(0);
                let visible_rows = usize::from(term_h.saturating_sub(3));
                let first = (at + 1).saturating_sub(visible_rows.max(1));
                let clicked_index = first.saturating_add(usize::from(mouse.row.saturating_sub(2)));
                let target = sorted.get(clicked_index).map(|c| c.login.clone());
                drop(sorted);
                if let Some(login) = target {
                    return model.select(&login);
                }
            }
            let chat_right = if term_w >= ui::INFO_PANEL_MIN_SCREEN && model.show_info {
                term_w.saturating_sub(ui::INFO_PANEL)
            } else {
                term_w
            };
            if mouse.column.abs_diff(chat_right.saturating_sub(1)) <= 1
                && mouse.row >= 1
                && mouse.row + 3 <= term_h
            {
                *dragging = true;
                apply_scroll_track(mouse.row, term_h, model);
            }
            Vec::new()
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            if *dragging {
                let (_, term_h) = crossterm::terminal::size().unwrap_or((80, 24));
                apply_scroll_track(mouse.row, term_h, model);
            }
            Vec::new()
        }
        MouseEventKind::Up(MouseButton::Left) => {
            *dragging = false;
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn on_key(key: KeyEvent, model: &mut Model, input: &mut Input) -> Vec<Effect> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let page = crossterm::terminal::size()
        .ok()
        .and_then(|(_, h)| isize::try_from(h / 2).ok())
        .map_or(10, |half| half.max(1));
    match key.code {
        KeyCode::Char('c') if ctrl => return vec![Effect::Quit],
        KeyCode::Char('d') if ctrl => {
            if input.is_empty() {
                return vec![Effect::Quit];
            }
            input.delete();
        }
        KeyCode::Char('n') if ctrl => return model.cycle(1),
        KeyCode::Char('p') if ctrl => return model.cycle(-1),
        KeyCode::Char('a') if ctrl => input.home(),
        KeyCode::Char('e') if ctrl => input.end(),
        KeyCode::Char('w') if ctrl => input.kill_word_back(),
        KeyCode::Char('u') if ctrl => input.kill_to_start(),
        KeyCode::Char('k') if ctrl => input.kill_to_end(),
        KeyCode::Char('b') if alt => input.word_left(),
        KeyCode::Char('f') if alt => input.word_right(),
        KeyCode::Char(c) if !ctrl && !alt => input.insert(c),
        KeyCode::Enter if alt => input.insert('\n'),
        KeyCode::Enter => {
            let line = input.take();
            return model.submit(&line);
        }
        KeyCode::Backspace if alt || ctrl => input.kill_word_back(),
        KeyCode::Backspace => input.backspace(),
        KeyCode::Delete => input.delete(),
        KeyCode::Left if ctrl || alt => input.word_left(),
        KeyCode::Right if ctrl || alt => input.word_right(),
        KeyCode::Left => input.left(),
        KeyCode::Right => input.right(),
        KeyCode::Home if input.is_empty() => {
            if let Some(peer) = model.current.as_ref()
                && let Some(conv) = model.convs.get_mut(peer)
            {
                conv.scroll = usize::MAX;
            }
        }
        KeyCode::End if input.is_empty() => {
            if let Some(peer) = model.current.as_ref()
                && let Some(conv) = model.convs.get_mut(peer)
            {
                conv.scroll = 0;
            }
        }
        KeyCode::Home => input.home(),
        KeyCode::End => input.end(),
        KeyCode::Up if alt => return model.cycle(-1),
        KeyCode::Down if alt => return model.cycle(1),
        KeyCode::Up => input.up(),
        KeyCode::Down => input.down(),
        KeyCode::Tab => return model.cycle(1),
        KeyCode::BackTab => return model.cycle(-1),
        KeyCode::PageUp => scroll(model, page),
        KeyCode::PageDown => scroll(model, -page),
        KeyCode::Esc => {
            if !input.is_empty() {
                input.clear();
            } else if let Some(peer) = model.current.as_ref()
                && let Some(conv) = model.convs.get_mut(peer)
                && conv.scroll > 0
            {
                conv.scroll = 0;
            } else if model.status.is_some() {
                model.status = None;
            }
        }
        _ => {}
    }
    Vec::new()
}

/// What `apply` needs to start a history fetch.
struct Fetch {
    api: String,
    token: String,
    done: mpsc::UnboundedSender<(String, Result<Value, String>)>,
}

/// Pictures written for the system viewer; removed when the program ends.
#[derive(Default)]
struct Temp(Vec<PathBuf>);

impl Drop for Temp {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// A new file only this user can read (a picture may be private).
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

/// Hands a picture to the system's viewer, through a temporary file.
fn open_in_viewer(image: &media::Media, temp: &mut Vec<PathBuf>) -> Result<(), String> {
    let path = std::env::temp_dir().join(format!("tcc-{}.{}", new_id(), image.ext));
    write_private(&path, &image.bytes).map_err(|e| e.to_string())?;
    temp.push(path.clone());
    let mut command = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else if cfg!(windows) {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    } else {
        std::process::Command::new("xdg-open")
    };
    let mut child = command
        .arg(&path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    // Reaped in the background so a closed viewer leaves no zombie behind.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Runs what the model asked for. `Some` ends the program.
async fn apply(
    effects: Vec<Effect>,
    model: &mut Model,
    link: &mut Link,
    fetch: &Fetch,
    temp: &mut Vec<PathBuf>,
) -> Option<Done> {
    let mut queue: VecDeque<Effect> = effects.into();
    while let Some(effect) = queue.pop_front() {
        match effect {
            Effect::Send(frame) => {
                if link.send(&frame).await == Sent::Broken {
                    lose(model, link);
                }
            }
            Effect::History(peer) => {
                let (api, token, done) = (fetch.api.clone(), fetch.token.clone(), fetch.done.clone());
                tokio::task::spawn_blocking(move || {
                    let page = net::history(&api, &token, &peer, HISTORY_LIMIT);
                    let _ = done.send((peer, page));
                });
            }
            Effect::Bell => {
                let mut out = std::io::stdout().lock();
                let _ = out.write_all(b"\x07");
                let _ = out.flush();
            }
            Effect::Open(image) => {
                if let Err(reason) = open_in_viewer(&image, temp) {
                    model.notice(format!("cannot open the picture: {reason}"));
                }
            }
            Effect::LoadImage { peer, path, caption } => {
                let file = media::clean_path(&path, home_dir().as_deref());
                match tokio::task::spawn_blocking(move || media::load_file(&file)).await {
                    Ok(Ok(image)) => queue.extend(model.send_image(&peer, image, &caption)),
                    Ok(Err(reason)) => model.notice(format!("/img: {reason}")),
                    Err(_) => model.notice("/img: reading the picture failed"),
                }
            }
            Effect::Quit => return Some(Done::Quit),
            Effect::Fatal(reason) => return Some(Done::Fatal(reason)),
        }
    }
    None
}

/// The socket is gone: the person is told by the status line, not by a print.
fn lose(model: &mut Model, link: &mut Link) {
    let delay = link.lost();
    let ms = i64::try_from(delay.as_millis()).unwrap_or(i64::MAX);
    model.set_link(LinkState::Offline {
        retry_at: model.now().saturating_add(ms),
    });
}

async fn run_chat(session: Session, mut model: Model) -> Done {
    let tls = match net::tls_config() {
        Ok(tls) => tls,
        Err(error) => return Done::Fatal(format!("TLS setup failed: {error}")),
    };
    let mut screen = match Screen::enter() {
        Ok(screen) => screen,
        Err(error) => return Done::Fatal(format!("cannot take over the terminal: {error}")),
    };
    let (done_tx, mut done_rx) = mpsc::unbounded_channel();
    let fetch = Fetch {
        api: session.endpoints.api.clone(),
        token: session.token.clone(),
        done: done_tx,
    };
    // Ask the terminal what it can draw: after the alternate screen is entered
    // and before anything reads its events.
    let mut gallery = Gallery::new(gallery::detect(env("TCC_IMAGES").as_deref()));
    model.notice(format!(
        "pictures: {} (TCC_IMAGES=off|halfblocks|kitty|sixel|iterm2 to change)",
        gallery.label()
    ));
    let (img_tx, mut img_rx) = mpsc::unbounded_channel::<(String, Result<DynamicImage, String>)>();
    let mut temp = Temp::default();
    let mut events = EventStream::new();
    let mut input = Input::default();
    let mut link = Link::new();
    let mut dragging = false;
    let mut tick = interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut read_at: Option<Instant> = None;
    let far = Instant::now() + Duration::from_secs(86_400);

    enum Step {
        Term(Option<std::io::Result<Event>>),
        Net(Net),
        History(Option<(String, Result<Value, String>)>),
        Image(Option<(String, Result<DynamicImage, String>)>),
        Dial,
        Read,
        Tick,
    }

    loop {
        // Pictures of the open conversation are decoded off the screen's thread.
        for (id, media) in gallery.wanted(&model) {
            let tx = img_tx.clone();
            tokio::task::spawn_blocking(move || {
                let _ = tx.send((id, media.decode(gallery::DECODE_SIDE)));
            });
        }
        if let Err(error) = screen
            .draw(|f| ui::draw(f, &mut model, &input, &mut gallery))
        {
            return Done::Fatal(format!("cannot draw: {error}"));
        }
        let retry_at = link.retry_at;
        let up = link.is_up();
        let step = tokio::select! {
            event = events.next() => Step::Term(event),
            net = link.recv() => Step::Net(net),
            page = done_rx.recv() => Step::History(page),
            pic = img_rx.recv() => Step::Image(pic),
            () = sleep_until(retry_at), if !up => Step::Dial,
            () = sleep_until(read_at.unwrap_or(far)), if read_at.is_some() => Step::Read,
            _ = tick.tick() => Step::Tick,
        };
        let cur_before = model.current.clone();
        let effects = match step {
            Step::Term(None | Some(Err(_))) => return Done::Quit,
            Step::Term(Some(Ok(Event::Key(key)))) if key.kind != KeyEventKind::Release => {
                on_key(key, &mut model, &mut input)
            }
            Step::Term(Some(Ok(Event::Paste(text)))) => {
                input.insert_str(&text);
                Vec::new()
            }
            Step::Term(Some(Ok(Event::Mouse(mouse)))) => on_mouse(mouse, &mut model, &mut dragging),
            Step::Term(Some(Ok(_))) | Step::Tick => Vec::new(), // resize, focus: a redraw is all
            Step::History(Some((peer, page))) => {
                model.on_history(&peer, page);
                Vec::new()
            }
            Step::History(None) => Vec::new(),
            Step::Image(Some((id, decoded))) => {
                gallery.finish(id, decoded);
                Vec::new()
            }
            Step::Image(None) => Vec::new(),
            Step::Net(Net::Text(text)) => match serde_json::from_str::<Value>(&text) {
                Ok(frame) => {
                    let before = model.link;
                    let effects = model.on_server(&frame);
                    if model.link == LinkState::Online && before != LinkState::Online {
                        link.settled();
                    }
                    effects
                }
                Err(_) => Vec::new(), // a frame that cannot be read cannot be acted on
            },
            Step::Net(Net::Lost) => {
                lose(&mut model, &mut link);
                Vec::new()
            }
            Step::Dial => {
                model.set_link(LinkState::Connecting);
                let _ = screen.draw(|f| ui::draw(f, &mut model, &input, &mut gallery));
                if let Err(error) = link.dial(&session.endpoints, &tls, &session.token).await {
                    lose(&mut model, &mut link);
                    model.notice(format!("cannot connect: {error}"));
                }
                Vec::new()
            }
            Step::Read => {
                read_at = None;
                model.take_read().map(Effect::Send).into_iter().collect()
            }
        };
        if cur_before != model.current {
            gallery.clear_cache();
        }
        if let Some(done) = apply(effects, &mut model, &mut link, &fetch, &mut temp.0).await {
            link.close().await;
            return done;
        }
        if model.read_pending() && read_at.is_none() {
            read_at = Some(Instant::now() + READ_DEBOUNCE);
        }
    }
}

fn cmd_chat(server: Option<String>, peer: Option<String>) -> ExitCode {
    if !std::io::stdout().is_terminal() || !std::io::stdin().is_terminal() {
        return fail("the chat screen needs a terminal; in scripts use `tcc send` or `tcc who`");
    }
    let session = match session(server) {
        Ok(session) => session,
        Err(reason) => return fail(&reason),
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => return fail(&format!("cannot start the runtime: {error}")),
    };
    let model = Model::new(peer, true, now_ms, new_id);
    let done = runtime.block_on(run_chat(session, model));
    // A history fetch may still be in flight; do not wait for it to finish.
    runtime.shutdown_background();
    match done {
        Done::Quit => ExitCode::SUCCESS,
        Done::Fatal(reason) => fail(&reason),
    }
}

/// The lines `tcc send` delivers: its arguments as one message, or stdin's lines.
fn send_lines(text: Option<String>) -> Result<Vec<String>, String> {
    if let Some(text) = text {
        return Ok(vec![text]);
    }
    if std::io::stdin().is_terminal() {
        return Err("usage: tcc send <login> <text>  (or pipe the text in)".to_owned());
    }
    let lines: Vec<String> = std::io::stdin()
        .lock()
        .lines()
        .map_while(Result::ok)
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return Err("nothing to send".to_owned());
    }
    Ok(lines)
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&argv) {
        Ok(args) => args,
        Err(reason) => return fail(&format!("{reason}\n\n{USAGE}")),
    };
    let server = args.server;
    match args.command {
        Command::Help => {
            say(USAGE);
            ExitCode::SUCCESS
        }
        Command::Version => {
            say(concat!("tcc ", env!("CARGO_PKG_VERSION")));
            ExitCode::SUCCESS
        }
        Command::Login => cmd_login(server),
        Command::Logout => cmd_logout(),
        Command::Who => cmd_job(server, Job::Who),
        Command::Send { peer, text } => match send_lines(text) {
            Ok(lines) => cmd_job(server, Job::Send { peer, lines }),
            Err(reason) => fail(&reason),
        },
        Command::Chat(peer) => cmd_chat(server, peer),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(words: &[&str]) -> Result<Args, String> {
        parse_args(&words.iter().map(|w| (*w).to_owned()).collect::<Vec<_>>())
    }

    fn command(words: &[&str]) -> Command {
        parse(words).expect("valid").command
    }

    #[test]
    fn arguments_pick_a_command() {
        assert_eq!(command(&[]), Command::Chat(None));
        assert_eq!(command(&["@Bob"]), Command::Chat(Some("bob".to_owned())));
        assert_eq!(command(&["who"]), Command::Who);
        assert_eq!(command(&["logout"]), Command::Logout);
        assert_eq!(command(&["-V"]), Command::Version);
        assert_eq!(command(&["--help", "whatever"]), Command::Help);
        assert_eq!(
            command(&["send", "@Bob", "hello", "there"]),
            Command::Send { peer: "bob".to_owned(), text: Some("hello there".to_owned()) }
        );
        assert_eq!(
            command(&["send", "bob"]),
            Command::Send { peer: "bob".to_owned(), text: None }
        );
    }

    #[test]
    fn the_server_can_come_from_a_flag_or_login_s_argument() {
        let parsed = parse(&["-s", "http://127.0.0.1:1", "who"]).expect("valid");
        assert_eq!(parsed.server.as_deref(), Some("http://127.0.0.1:1"));
        let login = parse(&["login", "example.org"]).expect("valid");
        assert_eq!((login.command, login.server.as_deref()), (Command::Login, Some("example.org")));
    }

    #[test]
    fn nonsense_is_refused_with_a_reason() {
        assert!(parse(&["--nope"]).is_err());
        assert!(parse(&["--server"]).is_err());
        assert!(parse(&["send"]).is_err());
        assert!(parse(&["bob", "alice"]).is_err());
        assert!(parse(&["who", "extra"]).is_err());
    }

    #[test]
    fn the_state_dir_is_home_then_userprofile() {
        let os = |s: &str| Some(OsString::from(s));
        let want = |s: &str| Some(PathBuf::from(s).join(".tailchat"));
        assert_eq!(state_dir_from(os("/home/a"), os("C:\\Users\\a")), want("/home/a"));
        // Windows: no HOME, or an empty one.
        assert_eq!(state_dir_from(None, os("C:\\Users\\a")), want("C:\\Users\\a"));
        assert_eq!(state_dir_from(os(""), os("C:\\Users\\a")), want("C:\\Users\\a"));
        assert_eq!(state_dir_from(None, None), None);
    }

    #[test]
    fn ids_are_unique_and_shaped_like_the_web_clients() {
        let (a, b) = (new_id(), new_id());
        assert_ne!(a, b);
        assert_eq!(a.len(), 34);
        assert!(a.starts_with("m-") && a.chars().skip(2).all(|c| c.is_ascii_hexdigit()));
    }
}
