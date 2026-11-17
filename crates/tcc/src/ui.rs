//! The screen: roster on the left, the open conversation on the right, one
//! line to type in, one line of status. Everything is drawn from the
//! [`Model`]; nothing here decides anything.

use chrono::{DateTime, Local, NaiveDate};
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState};
use ratatui_image::StatefulImage;

use crate::gallery::{self, Gallery, State};
use crate::model::{Contact, LinkState, Model, Msg, Rung};
use crate::text::{Input, to_u16, truncate, width, wrap};

/// The roster column, border included; hidden on a narrower terminal.
pub const SIDEBAR: u16 = 26;
/// Below this width the roster gives way to the conversation.
pub const SIDEBAR_MIN_SCREEN: u16 = 56;
/// The right info panel column; hidden on narrower screens.
pub const INFO_PANEL: u16 = 26;
/// Below this width the info panel gives way to keep the chat spacious.
pub const INFO_PANEL_MIN_SCREEN: u16 = 108;
/// The widest name column in a transcript.
const NAME_MAX: usize = 14;
const PROMPT: &str = "› ";
const ACCENT: Color = Color::Cyan;
const PEERS: [Color; 5] = [
    Color::Yellow,
    Color::Magenta,
    Color::Green,
    Color::Blue,
    Color::Red,
];

fn dim() -> Style {
    Style::new().add_modifier(Modifier::DIM)
}

fn local(ts: i64) -> Option<DateTime<Local>> {
    DateTime::from_timestamp_millis(ts).map(|utc| utc.with_timezone(&Local))
}

fn day_label(day: NaiveDate, today: NaiveDate) -> String {
    if day == today {
        "Today".to_owned()
    } else if today.pred_opt() == Some(day) {
        "Yesterday".to_owned()
    } else if day.format("%Y").to_string() == today.format("%Y").to_string() {
        day.format("%-d %b").to_string()
    } else {
        day.format("%-d %b %Y").to_string()
    }
}

fn color_of(login: &str) -> Color {
    let sum = login
        .bytes()
        .fold(0usize, |acc, b| acc.wrapping_add(usize::from(b)));
    PEERS.get(sum % PEERS.len()).copied().unwrap_or(Color::White)
}

fn spans_width(spans: &[Span<'_>]) -> usize {
    spans.iter().map(|s| width(&s.content)).sum()
}

/// The receipt mark of an own message: ⧗ ✓ ✓✓ (read in green), ⚠ on refusal.
fn receipt(msg: &Msg) -> Span<'static> {
    if msg.failed {
        return Span::styled("⚠", Style::new().fg(Color::Red));
    }
    match msg.rung {
        Rung::Queued => Span::styled("⧗", Style::new().fg(Color::Yellow)),
        Rung::Sent => Span::styled("✓", dim()),
        Rung::Delivered => Span::styled("✓✓", dim()),
        Rung::Read => Span::styled("✓✓", Style::new().fg(Color::Green)),
    }
}

fn reactions_text(msg: &Msg) -> String {
    msg.reactions
        .iter()
        .map(|(emoji, who)| {
            if who.len() > 1 {
                format!("{emoji}{}", who.len())
            } else {
                emoji.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Where a picture goes among a transcript's lines.
struct Slot {
    id: String,
    /// The first line reserved for it.
    line: usize,
    /// Cells from the left edge of the transcript.
    x: usize,
    cols: usize,
    rows: usize,
}

/// A conversation as styled lines, wrapped to `cols` cells, and where its
/// pictures go (the lines reserved for them are blank).
fn transcript(
    model: &Model,
    peer: &str,
    cols: usize,
    gallery: &Gallery,
) -> (Vec<Line<'static>>, Vec<Slot>) {
    let mut slots = Vec::new();
    let Some(conv) = model.convs.get(peer) else {
        return (Vec::new(), slots);
    };
    let peer_title = model.title(peer);
    let name_w = conv
        .msgs
        .iter()
        .filter(|m| !m.system)
        .map(|m| {
            if m.mine {
                3
            } else if m.author.is_empty() {
                width(&peer_title)
            } else {
                width(&m.author)
            }
        })
        .max()
        .unwrap_or(3)
        .clamp(3, NAME_MAX);
    let prefix_w = 5 + 1 + name_w + 1;
    // The text leaves room for a receipt on the right.
    let text_w = cols.saturating_sub(prefix_w + 4).max(8);
    let today = local(model.now()).map(|d| d.date_naive());
    let mut lines = Vec::new();
    let mut last_day: Option<NaiveDate> = None;
    for msg in &conv.msgs {
        let when = local(msg.ts);
        if let (Some(when), Some(today)) = (when, today)
            && last_day != Some(when.date_naive())
        {
            last_day = Some(when.date_naive());
            lines.push(Line::from(Span::styled(
                format!("── {} ──", day_label(when.date_naive(), today)),
                dim(),
            )));
        }
        if msg.system {
            for part in wrap(&msg.text, cols.saturating_sub(4).max(8)) {
                lines.push(Line::from(Span::styled(
                    format!("  · {part}"),
                    dim().add_modifier(Modifier::ITALIC),
                )));
            }
            continue;
        }
        let stamp = when.map_or_else(|| "--:--".to_owned(), |d| d.format("%H:%M").to_string());
        let (name, name_style) = if msg.mine {
            ("you".to_owned(), Style::new().fg(ACCENT).add_modifier(Modifier::BOLD))
        } else if msg.author.is_empty() {
            (peer_title.clone(), Style::new().fg(color_of(peer)).add_modifier(Modifier::BOLD))
        } else {
            (msg.author.clone(), Style::new().fg(color_of(&msg.author)).add_modifier(Modifier::BOLD))
        };
        let name = truncate(&name, name_w);
        let pad = " ".repeat(name_w.saturating_sub(width(&name)));
        let mut body = msg.text.clone();
        for tag in &msg.tags {
            if !body.is_empty() {
                body.push(' ');
            }
            body.push_str(tag);
        }
        // Where pictures cannot be drawn they are at least named, with their size.
        if let Some(image) = msg.image.as_ref().filter(|_| !gallery.enabled()) {
            if !body.is_empty() {
                body.push(' ');
            }
            body.push_str(&format!("[image {}×{}]", image.width, image.height));
        }
        let parts = wrap(&body, text_w);
        let last = parts.len().saturating_sub(1);
        for (i, part) in parts.into_iter().enumerate() {
            let mut spans: Vec<Span<'static>> = if i == 0 {
                vec![
                    Span::styled(stamp.clone(), dim()),
                    Span::raw(" "),
                    Span::styled(format!("{pad}{name}"), name_style),
                    Span::raw(" "),
                ]
            } else {
                vec![Span::raw(" ".repeat(prefix_w))]
            };
            spans.push(Span::raw(part));
            if i == last {
                if msg.edited {
                    spans.push(Span::styled(" (edited)", dim()));
                }
                let tally = reactions_text(msg);
                if !tally.is_empty() {
                    spans.push(Span::raw("  "));
                    spans.push(Span::styled(format!("[ {tally} ]"), Style::new().fg(Color::Yellow).add_modifier(Modifier::BOLD)));
                }
                if msg.mine {
                    let mark = receipt(msg);
                    let gap = cols
                        .saturating_sub(spans_width(&spans) + width(&mark.content))
                        .max(1);
                    spans.push(Span::raw(" ".repeat(gap)));
                    spans.push(mark);
                }
            }
            lines.push(Line::from(spans));
        }
        if let Some(image) = msg.image.as_ref().filter(|_| gallery.enabled()) {
            let max_cols = text_w.min(gallery::MAX_COLS);
            let (w, h) = gallery::cells(image.width, image.height, gallery.font(), max_cols, gallery::MAX_ROWS);
            slots.push(Slot {
                id: msg.id.clone(),
                line: lines.len(),
                x: prefix_w,
                cols: w,
                rows: h,
            });
            lines.extend(std::iter::repeat_n(Line::default(), h));
        }
    }
    (lines, slots)
}

fn roster_row(model: &Model, contact: &Contact, selected: bool, cols: usize) -> Line<'static> {
    let lamp = if contact.online {
        Span::styled("●", Style::new().fg(Color::Green))
    } else {
        Span::styled("○", dim())
    };
    let badge = if contact.pending > 0 {
        format!(" {} ", contact.pending.min(99))
    } else {
        String::new()
    };
    let marker = if selected { "▌" } else { " " };
    let room = cols.saturating_sub(3 + width(&badge) + 1);
    let title = truncate(&model.title(&contact.login), room);
    let gap = cols.saturating_sub(3 + width(&title) + width(&badge));
    let mut spans = vec![
        Span::styled(marker, Style::new().fg(ACCENT)),
        lamp,
        Span::raw(" "),
        Span::styled(
            title,
            if selected {
                Style::new().add_modifier(Modifier::BOLD)
            } else if contact.official {
                dim()
            } else {
                Style::new()
            },
        ),
        Span::raw(" ".repeat(gap)),
    ];
    if !badge.is_empty() {
        spans.push(Span::styled(
            badge,
            Style::new().fg(Color::Black).bg(ACCENT).add_modifier(Modifier::BOLD),
        ));
    }
    let line = Line::from(spans);
    if selected {
        line.style(Style::new().add_modifier(Modifier::REVERSED))
    } else {
        line
    }
}

fn draw_roster(frame: &mut Frame, model: &Model, area: Rect) {
    let block = Block::new().borders(Borders::RIGHT).border_style(dim());
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let cols = usize::from(inner.width);
    let mut lines = vec![
        Line::from(vec![
            Span::styled(" tcc", Style::new().fg(ACCENT).add_modifier(Modifier::BOLD)),
            Span::styled(format!("  @{}", model.me), dim()),
        ]),
        Line::from(Span::styled("─".repeat(cols), dim())),
    ];
    let sorted = model.sorted();
    let at = sorted
        .iter()
        .position(|c| model.current.as_deref() == Some(c.login.as_str()))
        .unwrap_or(0);
    let rows = usize::from(inner.height).saturating_sub(lines.len());
    let first = (at + 1).saturating_sub(rows.max(1));
    for contact in sorted.iter().skip(first).take(rows) {
        let selected = model.current.as_deref() == Some(contact.login.as_str());
        lines.push(roster_row(model, contact, selected, cols));
    }
    frame.render_widget(Paragraph::new(lines), inner);
}

fn draw_header(frame: &mut Frame, model: &Model, area: Rect) {
    let Some(peer) = model.current.as_deref() else {
        frame.render_widget(
            Paragraph::new(Span::styled(" tcc", Style::new().add_modifier(Modifier::BOLD))),
            area,
        );
        return;
    };
    let online = model.contact(peer).is_some_and(|c| c.online);
    let mut spans = vec![
        Span::styled(
            format!(" {}", model.title(peer)),
            Style::new().add_modifier(Modifier::BOLD).fg(color_of(peer)),
        ),
        Span::styled(format!("  @{peer} "), dim()),
        if online {
            Span::styled("● online", Style::new().fg(Color::Green))
        } else {
            Span::styled("○ away", dim())
        },
    ];
    if let Some(conv) = model.convs.get(peer) {
        if conv.typing_until > model.now() {
            spans.push(Span::styled(
                "  ✍ typing…",
                Style::new().fg(ACCENT).add_modifier(Modifier::ITALIC),
            ));
        }
        if conv.unseen > 0 {
            let note = format!("↓ {} new ", conv.unseen);
            let gap = usize::from(area.width).saturating_sub(spans_width(&spans) + width(&note));
            spans.push(Span::raw(" ".repeat(gap)));
            spans.push(Span::styled(note, Style::new().fg(Color::Black).bg(ACCENT)));
        } else if conv.scroll > 0 {
            let note = format!(" ↑ scrolled ({} lines) · Esc bottom ", conv.scroll);
            let gap = usize::from(area.width).saturating_sub(spans_width(&spans) + width(&note));
            spans.push(Span::raw(" ".repeat(gap)));
            spans.push(Span::styled(note, Style::new().fg(Color::Yellow).add_modifier(Modifier::DIM)));
        }
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn draw_transcript(frame: &mut Frame, model: &mut Model, gallery: &mut Gallery, area: Rect) {
    let Some(peer) = model.current.clone() else {
        let hint = if model.contacts.is_empty() {
            "No contacts yet. Add friends in the web app."
        } else {
            "Pick a conversation: Tab, or /to <login>."
        };
        frame.render_widget(Paragraph::new(Span::styled(format!("  {hint}"), dim())), area);
        return;
    };
    let rows = usize::from(area.height);
    let (lines, slots) = transcript(model, &peer, usize::from(area.width.saturating_sub(1)), gallery);
    let max_scroll = lines.len().saturating_sub(rows);
    let scroll = model
        .convs
        .get_mut(&peer)
        .map_or(0, |conv| {
            conv.max_scroll = max_scroll;
            conv.scroll = conv.scroll.min(max_scroll);
            if conv.scroll == 0 {
                conv.unseen = 0;
            }
            conv.scroll
        });
    let end = lines.len() - scroll;
    let start = end.saturating_sub(rows);
    let mut shown: Vec<Line> = lines.into_iter().skip(start).take(end - start).collect();
    if shown.is_empty() {
        shown.push(Line::from(Span::styled("  No messages yet.", dim())));
    }
    // A chat reads from the bottom up.
    let blank = rows.saturating_sub(shown.len());
    let mut all = vec![Line::default(); blank];
    all.extend(shown);
    frame.render_widget(Paragraph::new(all), area);
    // Pictures go over the lines reserved for them. One that is cut by the edge
    // of the view is not drawn (half a picture cannot be): a dim note stands in.
    for slot in slots {
        let (first, past) = (slot.line.max(start), (slot.line + slot.rows).min(end));
        if first >= past {
            continue;
        }
        let x = area.x + to_u16(slot.x);
        let width = to_u16(slot.cols).min(area.width.saturating_sub(to_u16(slot.x)));
        if width == 0 {
            continue;
        }
        let top = area.y + to_u16(blank + first - start);
        let whole = first == slot.line && past == slot.line + slot.rows;
        let ready = whole.then(|| gallery.protocol(&slot.id)).flatten();
        if let Some(protocol) = ready {
            let rect = Rect::new(x, top, width, to_u16(slot.rows));
            frame.render_stateful_widget(StatefulImage::default(), rect, protocol);
            continue;
        }
        let note = match gallery.state(&slot.id) {
            State::Failed => "cannot decode",
            State::Decoding => "decoding…",
            State::Absent => "not loaded: /open",
            State::Ready => "scroll to see",
        };
        frame.render_widget(
            Paragraph::new(Span::styled(format!("[picture: {note}]"), dim())),
            Rect::new(x, top, width, 1),
        );
    }
    if max_scroll > 0 {
        let mut scrollbar_state = ScrollbarState::new(max_scroll)
            .position(max_scroll.saturating_sub(scroll));
        let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .begin_symbol(Some("▲"))
            .end_symbol(Some("▼"))
            .track_symbol(Some("│"))
            .thumb_symbol("█")
            .track_style(dim())
            .thumb_style(Style::new().fg(ACCENT));
        frame.render_stateful_widget(scrollbar, area, &mut scrollbar_state);
    }
}

fn command_hint(input_text: &str) -> Option<&'static str> {
    let trimmed = input_text.trim();
    if !trimmed.starts_with('/') {
        return None;
    }
    let (cmd, _) = trimmed.split_once(char::is_whitespace).unwrap_or((trimmed, ""));
    match cmd {
        "/" => Some("/img <file> [caption]  ·  /open [n]  ·  /to <user>  ·  /who  ·  /edit  ·  /del  ·  /react  ·  /help"),
        s if "/img".starts_with(s) || "/image".starts_with(s) => Some("/img <file> [caption] — send picture (JPEG/PNG/GIF/WebP)"),
        s if "/open".starts_with(s) => Some("/open [n] — open picture in system viewer"),
        s if "/to".starts_with(s) => Some("/to <login> — switch conversation"),
        s if "/who".starts_with(s) => Some("/who — print roster and status"),
        s if "/edit".starts_with(s) => Some("/edit <text> — edit last message"),
        s if "/del".starts_with(s) => Some("/del [me] [n] — delete message"),
        s if "/react".starts_with(s) => Some("/react <emoji> — add reaction to last message"),
        s if "/unreact".starts_with(s) => Some("/unreact <emoji> — remove reaction"),
        s if "/retry".starts_with(s) => Some("/retry — retry sending failed messages"),
        s if "/clear".starts_with(s) => Some("/clear — reset scroll to bottom and clear status"),
        s if "/help".starts_with(s) => Some("/help — show all commands"),
        s if "/quit".starts_with(s) => Some("/quit — exit chat"),
        _ => None,
    }
}

fn draw_input(frame: &mut Frame, model: &Model, input: &Input, rule: Rect, row: Rect) {
    let text = input.text();
    let rule_spans = if let Some(hint) = command_hint(&text) {
        let label = format!("── {hint} ");
        let pad = usize::from(rule.width).saturating_sub(width(&label));
        vec![
            Span::styled(label, Style::new().fg(ACCENT).add_modifier(Modifier::BOLD)),
            Span::styled("─".repeat(pad), dim()),
        ]
    } else {
        vec![Span::styled("─".repeat(usize::from(rule.width)), dim())]
    };
    frame.render_widget(Paragraph::new(Line::from(rule_spans)), rule);
    let room = usize::from(row.width).saturating_sub(width(PROMPT));
    let (shown, column) = input.view(room);
    let mut spans = vec![Span::styled(PROMPT, Style::new().fg(ACCENT).add_modifier(Modifier::BOLD))];
    if input.is_empty() {
        let hint = match model.current.as_deref() {
            Some(peer) => format!("Message {}…  (Enter to send, /img to attach)", model.title(peer)),
            None => "Tab to pick a conversation".to_owned(),
        };
        spans.push(Span::styled(truncate(&hint, room), dim()));
    } else {
        spans.push(Span::raw(shown));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), row);
    frame.set_cursor_position(Position::new(
        row.x + to_u16(width(PROMPT) + column).min(row.width.saturating_sub(1)),
        row.y,
    ));
}

fn draw_status(frame: &mut Frame, model: &Model, gallery: &Gallery, area: Rect) {
    let now = model.now();
    let link_badge = match model.link {
        LinkState::Connecting => Span::styled(" ◌ connecting ", Style::new().fg(Color::Black).bg(Color::Yellow)),
        LinkState::Online => Span::styled(" ● connected ", Style::new().fg(Color::Black).bg(Color::Green).add_modifier(Modifier::BOLD)),
        LinkState::Offline { retry_at } => {
            let secs = ((retry_at - now).max(0) + 999) / 1000;
            Span::styled(format!(" ○ offline ({secs}s) "), Style::new().fg(Color::White).bg(Color::Red))
        }
    };
    let middle = match &model.status {
        Some((text, until)) if *until > now => {
            Span::styled(format!(" ⚠ {text} "), Style::new().fg(Color::Black).bg(Color::Yellow).add_modifier(Modifier::BOLD))
        }
        _ => {
            let pic = gallery.label();
            Span::styled(format!(" [Tab: chats] [Wheel: scroll] [Esc: bottom] [GFX: {pic}] [? /help] "), dim())
        }
    };
    let right = if model.me.is_empty() {
        Span::default()
    } else {
        Span::styled(format!(" [@{}] ", model.me), Style::new().fg(ACCENT).add_modifier(Modifier::BOLD))
    };
    let cols = usize::from(area.width);
    let left_w = width(&link_badge.content) + width(&middle.content);
    let right_w = width(&right.content);
    let gap = cols.saturating_sub(left_w + right_w);

    let spans = vec![
        link_badge,
        middle,
        Span::raw(" ".repeat(gap)),
        right,
    ];
    frame.render_widget(
        Paragraph::new(Line::from(spans)),
        area,
    );
}

fn draw_info_panel(frame: &mut Frame, model: &Model, gallery: &Gallery, area: Rect) {
    let block = Block::new()
        .borders(Borders::LEFT)
        .border_style(dim());
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let cols = usize::from(inner.width);
    let mut lines = Vec::new();

    // ── TELEMETRY / DETAILS ──
    lines.push(Line::from(vec![
        Span::styled("┌─ ", Style::new().fg(ACCENT)),
        Span::styled("Details · Telemetry", Style::new().fg(ACCENT).add_modifier(Modifier::BOLD)),
        Span::styled(format!(" ─{}", "─".repeat(cols.saturating_sub(24))), Style::new().fg(ACCENT)),
    ]));
    lines.push(Line::from(vec![
        Span::styled("  CORE   ", dim()),
        Span::styled("tcc-geek v0.2", Style::new().add_modifier(Modifier::BOLD)),
    ]));
    lines.push(Line::from(vec![
        Span::styled("  LINK   ", dim()),
        match model.link {
            LinkState::Online => Span::styled("● TLS1.3/ONLINE", Style::new().fg(Color::Green).add_modifier(Modifier::BOLD)),
            LinkState::Connecting => Span::styled("◌ CONNECTING", Style::new().fg(Color::Yellow)),
            LinkState::Offline { .. } => Span::styled("○ OFFLINE", dim()),
        },
    ]));
    let pic_mode = gallery.label();
    lines.push(Line::from(vec![
        Span::styled("  GFX    ", dim()),
        Span::styled(format!("DEC2026 · {pic_mode}"), Style::new().fg(Color::Yellow)),
    ]));

    // ── PEER INSPECTION ──
    lines.push(Line::from(Span::styled(format!("├{}", "─".repeat(cols.saturating_sub(1))), dim())));
    lines.push(Line::from(vec![
        Span::styled("  PEER   ", dim()),
        if let Some(peer) = model.current.as_deref() {
            Span::styled(format!("@{peer}"), Style::new().fg(color_of(peer)).add_modifier(Modifier::BOLD))
        } else {
            Span::styled("none", dim())
        },
    ]));
    if let Some(peer) = model.current.as_deref() {
        let contact = model.contact(peer);
        lines.push(Line::from(vec![
            Span::styled("  NAME   ", dim()),
            Span::styled(model.title(peer), Style::new().add_modifier(Modifier::BOLD)),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  STATE  ", dim()),
            if contact.is_some_and(|c| c.online) {
                Span::styled("● ACTIVE", Style::new().fg(Color::Green).add_modifier(Modifier::BOLD))
            } else {
                Span::styled("○ IDLE", dim())
            },
        ]));
    }

    // ── CONVERSATION METRICS ──
    lines.push(Line::from(Span::styled(format!("├{}", "─".repeat(cols.saturating_sub(1))), dim())));
    if let Some(peer) = model.current.as_deref()
        && let Some(conv) = model.convs.get(peer)
    {
        let photos = conv.msgs.iter().filter(|m| m.image.is_some()).count();
        lines.push(Line::from(vec![
            Span::styled("  Conversation: ", Style::new().add_modifier(Modifier::BOLD)),
            Span::styled(format!("{} msgs", conv.msgs.len()), Style::new().fg(ACCENT).add_modifier(Modifier::BOLD)),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  Photos:       ", dim()),
            Span::styled(format!("{photos} files"), Style::new().add_modifier(Modifier::BOLD)),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  Scroll:       ", dim()),
            if conv.scroll == 0 {
                Span::styled("0 (LIVE)", Style::new().fg(Color::Green))
            } else {
                Span::styled(format!("+{} lines", conv.scroll), Style::new().fg(Color::Yellow))
            },
        ]));
        if conv.unseen > 0 {
            lines.push(Line::from(vec![
                Span::styled("  Unread:       ", dim()),
                Span::styled(format!("{} new", conv.unseen), Style::new().fg(Color::Black).bg(ACCENT).add_modifier(Modifier::BOLD)),
            ]));
        }
    } else {
        lines.push(Line::from(Span::styled("  Conversation: none", dim())));
    }

    // ── SHORTCUTS ──
    lines.push(Line::from(Span::styled(format!("├{}", "─".repeat(cols.saturating_sub(1))), dim())));
    lines.push(Line::from(Span::styled(" Shortcuts", Style::new().add_modifier(Modifier::BOLD))));
    lines.push(Line::from(vec![Span::styled("  Tab   ", Style::new().fg(ACCENT)), Span::styled("switch chat", dim())]));
    lines.push(Line::from(vec![Span::styled("  Wheel ", Style::new().fg(ACCENT)), Span::styled("scroll chat", dim())]));
    lines.push(Line::from(vec![Span::styled("  Drag  ", Style::new().fg(ACCENT)), Span::styled("scrollbar", dim())]));
    lines.push(Line::from(vec![Span::styled("  Esc   ", Style::new().fg(ACCENT)), Span::styled("to bottom", dim())]));
    lines.push(Line::from(vec![Span::styled("  /img  ", Style::new().fg(ACCENT)), Span::styled("send picture", dim())]));
    lines.push(Line::from(vec![Span::styled("  /open ", Style::new().fg(ACCENT)), Span::styled("view viewer", dim())]));
    lines.push(Line::from(vec![Span::styled("  /clear", Style::new().fg(ACCENT)), Span::styled("reset view", dim())]));
    lines.push(Line::from(vec![Span::styled("  /info ", Style::new().fg(ACCENT)), Span::styled("toggle panel", dim())]));
    lines.push(Line::from(Span::styled(format!("└{}", "─".repeat(cols.saturating_sub(1))), dim())));

    let max_rows = usize::from(inner.height);
    lines.truncate(max_rows);
    frame.render_widget(Paragraph::new(lines), inner);
}

/// One frame. Also clamps the open conversation's scroll to what exists.
pub fn draw(frame: &mut Frame, model: &mut Model, input: &Input, gallery: &mut Gallery) {
    let [main, status] = Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).areas(frame.area());
    let (chat_area, right_panel) = if main.width >= INFO_PANEL_MIN_SCREEN && model.show_info {
        let [left_and_mid, right] =
            Layout::horizontal([Constraint::Min(1), Constraint::Length(INFO_PANEL)]).areas(main);
        (left_and_mid, Some(right))
    } else {
        (main, None)
    };
    let body = if chat_area.width >= SIDEBAR_MIN_SCREEN {
        let [side, body] =
            Layout::horizontal([Constraint::Length(SIDEBAR), Constraint::Min(1)]).areas(chat_area);
        draw_roster(frame, model, side);
        body
    } else {
        chat_area
    };
    let [header, transcript_area, rule, row] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(body);
    draw_header(frame, model, header);
    draw_transcript(frame, model, gallery, transcript_area);
    draw_input(frame, model, input, rule, row);
    draw_status(frame, model, gallery, status);
    if let Some(panel) = right_panel {
        draw_info_panel(frame, model, gallery, panel);
    }
}
#[cfg(test)]
mod tests {
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use serde_json::json;

    use super::*;
    use crate::model::Effect;

    fn screen(model: &mut Model, input: &Input, w: u16, h: u16) -> Vec<String> {
        screen_with(model, input, &mut Gallery::new(None), w, h)
    }

    fn screen_with(
        model: &mut Model,
        input: &Input,
        gallery: &mut Gallery,
        w: u16,
        h: u16,
    ) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(w, h)).expect("terminal");
        terminal.draw(|f| draw(f, model, input, gallery)).expect("draw");
        let buffer = terminal.backend().buffer().clone();
        (0..h)
            .map(|y| {
                (0..w)
                    .map(|x| buffer.cell((x, y)).map_or(" ", |c| c.symbol()))
                    .collect::<String>()
            })
            .collect()
    }

    fn live_model() -> Model {
        let mut model = Model::new(Some("bob".into()), true, || 1_700_000_000_000, || "m-ui".into());
        model.on_server(&json!({
            "k": "ready", "self": {"login": "alice"},
            "users": [
                {"login": "bob", "name": "Bob", "online": true},
                {"login": "carol", "name": "Carol", "online": false, "pending": 3},
            ],
        }));
        model
    }

    #[test]
    fn the_screen_shows_roster_transcript_marks_and_input() {
        let mut model = live_model();
        model.on_history(
            "bob",
            Ok(json!({
                "messages": [
                    {"id": "b1", "from": "bob", "text": "hello alice", "ts": 1_699_999_000_000_i64},
                    {"id": "a1", "from": "alice", "text": "hi bob", "ts": 1_699_999_100_000_i64},
                    {"id": "a2", "from": "alice", "text": "still there", "ts": 1_699_999_200_000_i64},
                ],
                "peerReadTs": 1_699_999_100_000_i64,
                "peerDeliveredTs": 1_699_999_100_000_i64,
            })),
        );
        let mut input = Input::default();
        input.insert_str("draft text");
        let rows = screen(&mut model, &input, 90, 16);
        let all = rows.join("\n");
        assert!(all.contains("@alice"), "{all}");
        assert!(all.contains("● Bob"), "{all}");
        assert!(all.contains("○ Carol"), "{all}");
        assert!(all.contains(" 3 "), "the unread badge: {all}");
        assert!(all.contains("@bob ● online"), "{all}");
        assert!(all.contains("hello alice"), "{all}");
        let hi = rows.iter().find(|r| r.contains("hi bob")).expect("own message row");
        assert!(hi.trim_end().ends_with("✓✓"), "read mark at the right edge: {hi:?}");
        let later = rows.iter().find(|r| r.contains("still there")).expect("row");
        assert!(later.trim_end().ends_with('✓'), "only sent: {later:?}");
        assert!(all.contains("› draft text"), "{all}");
        assert!(all.contains("connected"), "{all}");
    }

    #[test]
    fn a_narrow_terminal_drops_the_roster_and_still_draws() {
        let mut model = live_model();
        model.submit("a fairly long message that has to wrap around the narrow screen twice");
        let rows = screen(&mut model, &Input::default(), 40, 12);
        let all = rows.join("\n");
        assert!(!all.contains("● Bob"), "no roster at 40 columns: {all}");
        assert!(all.contains("⧗"), "queued mark: {all}");
        let wrapped = rows.iter().filter(|r| r.contains("narrow") || r.contains("screen")).count();
        assert!(wrapped >= 1, "{all}");
        // Zero-size and tiny terminals must not panic.
        for (w, h) in [(1, 1), (10, 3), (30, 2)] {
            screen(&mut model, &Input::default(), w, h);
        }
    }

    #[test]
    fn scrolling_up_is_clamped_and_new_messages_are_counted() {
        let mut model = live_model();
        for i in 0..40 {
            let frame = json!({"k": "frame", "from": "bob", "d": {"t": "msg", "id": format!("b{i}"), "text": format!("line {i}"), "ts": 1_699_999_000_000_i64 + i}});
            model.on_server(&frame);
        }
        if let Some(conv) = model.convs.get_mut("bob") {
            conv.scroll = 10_000;
        }
        let rows = screen(&mut model, &Input::default(), 90, 14);
        assert!(rows.join("\n").contains("line 0"), "clamped to the top");
        assert!(model.convs.get("bob").is_some_and(|c| c.scroll < 10_000));
        assert!(rows.join("\n").contains("scrolled"));
        let more = json!({"k": "frame", "from": "bob", "d": {"t": "msg", "id": "late", "text": "new one"}});
        assert!(matches!(model.on_server(&more)[..], []), "viewing: no bell");
        let rows = screen(&mut model, &Input::default(), 90, 14);
        assert!(rows.join("\n").contains("↓ 1 new"));
        assert_eq!(model.on_server(&json!({"k": "unread", "from": "carol", "count": 4})), [Effect::Bell]);
    }

    /// What the half-block renderer draws a picture's cells with.
    fn is_half(c: char) -> bool {
        matches!(c, '▄' | '▀')
    }

    /// A 200×100 gradient as a history record, drawn by a half-block gallery.
    fn model_with_a_picture() -> Model {
        let mut model = live_model();
        let image = crate::media::Media::from_bytes(crate::media::test_png(200, 100)).expect("png");
        model.on_history(
            "bob",
            Ok(json!({"messages": [
                {"id": "t1", "from": "bob", "text": "before the picture", "ts": 1_699_999_000_000_i64},
                {"id": "i1", "from": "bob", "text": "", "ts": 1_699_999_100_000_i64, "image": image.to_value()},
                {"id": "t2", "from": "alice", "text": "after the picture", "ts": 1_699_999_200_000_i64},
            ]})),
        );
        model
    }

    fn decoded_gallery(model: &Model) -> Gallery {
        let mut gallery = Gallery::new(Some(ratatui_image::picker::Picker::halfblocks()));
        for (id, media) in gallery.wanted(model) {
            gallery.finish(id, media.decode(gallery::DECODE_SIDE));
        }
        gallery
    }

    #[test]
    fn a_picture_gets_its_own_rows_between_the_messages_around_it() {
        let mut model = model_with_a_picture();
        let mut gallery = decoded_gallery(&model);
        let rows = screen_with(&mut model, &Input::default(), &mut gallery, 100, 30);
        let (cols, height) = gallery::cells(200, 100, gallery.font(), 60, gallery::MAX_ROWS);
        let drawn: Vec<usize> = rows
            .iter()
            .enumerate()
            .filter(|(_, r)| r.contains(is_half))
            .map(|(i, _)| i)
            .collect();
        assert_eq!(drawn.len(), height, "{rows:#?}");
        assert!(drawn.windows(2).all(|w| w[1] == w[0] + 1), "contiguous rows");
        let before = rows.iter().position(|r| r.contains("before the picture")).expect("before");
        let after = rows.iter().position(|r| r.contains("after the picture")).expect("after");
        assert!(before < drawn[0] && drawn[drawn.len() - 1] < after, "the picture sits between them");
        let widest = rows[drawn[0]].chars().filter(|c| is_half(*c)).count();
        assert!(widest >= cols - 1 && widest <= cols, "{widest} cells for {cols}");
        assert!(!rows.join("\n").contains("[picture"), "no stand-in once it is drawn");
    }

    #[test]
    fn while_decoding_a_note_holds_the_place_and_nothing_jumps_when_it_arrives() {
        let mut model = model_with_a_picture();
        let mut gallery = Gallery::new(Some(ratatui_image::picker::Picker::halfblocks()));
        let pending = gallery.wanted(&model);
        let before = screen_with(&mut model, &Input::default(), &mut gallery, 100, 30);
        assert!(before.join("\n").contains("[picture: decoding…]"));
        let line_of = |rows: &[String]| rows.iter().position(|r| r.contains("after the picture"));
        let was = line_of(&before);
        for (id, media) in pending {
            gallery.finish(id, media.decode(gallery::DECODE_SIDE));
        }
        let after = screen_with(&mut model, &Input::default(), &mut gallery, 100, 30);
        assert_eq!(line_of(&after), was, "the layout does not depend on the decode");
    }

    #[test]
    fn without_a_gallery_the_picture_is_named_with_its_size() {
        let mut model = model_with_a_picture();
        let rows = screen(&mut model, &Input::default(), 100, 30).join("\n");
        assert!(rows.contains("[image 200×100]"), "{rows}");
        assert!(!rows.contains(is_half));
    }

    #[test]
    fn a_picture_cut_by_the_edge_is_replaced_by_a_note_not_half_drawn() {
        let mut model = model_with_a_picture();
        let mut gallery = decoded_gallery(&model);
        // Eight transcript rows cannot hold a 5-row picture plus the messages
        // around it once scrolled up by a few lines.
        if let Some(conv) = model.convs.get_mut("bob") {
            conv.scroll = 3;
        }
        let rows = screen_with(&mut model, &Input::default(), &mut gallery, 100, 13);
        let all = rows.join("\n");
        assert!(all.contains("[picture: scroll to see]") || all.contains(is_half), "{all}");
        for (w, h) in [(1, 1), (30, 4), (100, 3)] {
            screen_with(&mut model, &Input::default(), &mut gallery, w, h); // must not panic
        }
    }

    #[test]
    fn wide_terminal_shows_the_right_info_panel() {
        let mut model = live_model();
        model.on_history(
            "bob",
            Ok(json!({
                "messages": [
                    {"id": "b1", "from": "bob", "text": "hello alice", "ts": 1_699_999_000_000_i64},
                ],
            })),
        );
        let rows = screen(&mut model, &Input::default(), 120, 24);
        let all = rows.join("\n");
        assert!(all.contains("Details"), "info panel title: {all}");
        assert!(all.contains("Shortcuts"), "shortcuts section: {all}");
        assert!(all.contains("Conversation"), "conversation stats: {all}");
        assert!(all.contains("@bob ● online"), "chat header: {all}");
    }
}
