//! The pictures of the open conversation: decoded in the background, kept in a
//! form the terminal can draw, and measured in character cells.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use image::DynamicImage;
use ratatui_image::picker::{Picker, ProtocolType};
use ratatui_image::protocol::StatefulProtocol;

use crate::media::Media;
use crate::model::Model;

/// Pixels a decoded picture is kept at, per side: terminal cells display at most ~60×14 cells.
/// 640 px gives crisp high-DPI output while using 4x less memory than 1024 px.
pub const DECODE_SIDE: u32 = 640;
/// Decoded pictures kept at once in the LRU cache (saves hundreds of MBs of RAM).
const KEEP: usize = 8;
/// Only this many of the newest pictures of a conversation are decoded at once.
const WANT: usize = 4;
/// The widest a picture is drawn in a transcript, in cells.
pub const MAX_COLS: usize = 60;
/// The tallest, in cells.
pub const MAX_ROWS: usize = 14;

/// What `TCC_IMAGES` asks for.
#[derive(Debug, PartialEq)]
pub enum Mode {
    /// No pictures: `[image]` tags only.
    Off,
    /// Whatever the terminal answers to.
    Auto,
    /// This protocol, whatever the terminal answers.
    Force(ProtocolType),
}

pub fn mode(setting: Option<&str>) -> Mode {
    match setting.map(|s| s.trim().to_lowercase()).as_deref() {
        Some("off" | "0" | "no" | "false" | "none") => Mode::Off,
        Some("halfblocks" | "blocks") => Mode::Force(ProtocolType::Halfblocks),
        Some("kitty") => Mode::Force(ProtocolType::Kitty),
        Some("sixel") => Mode::Force(ProtocolType::Sixel),
        Some("iterm2" | "iterm") => Mode::Force(ProtocolType::Iterm2),
        _ => Mode::Auto,
    }
}

fn font_size() -> (u16, u16) {
    if let Ok(size) = crossterm::terminal::window_size()
        && size.columns > 0
        && size.rows > 0
        && size.width > 0
        && size.height > 0
    {
        let fw = size.width / size.columns;
        let fh = size.height / size.rows;
        if fw > 0 && fh > 0 {
            return (fw, fh);
        }
    }
    (10, 20)
}

fn guess_protocol() -> ProtocolType {
    if std::env::var_os("KITTY_WINDOW_ID").is_some()
        || std::env::var_os("GHOSTTY_RESOURCES_DIR").is_some()
        || std::env::var("TERM").is_ok_and(|t| t == "xterm-kitty")
    {
        return ProtocolType::Kitty;
    }
    if std::env::var("TERM_PROGRAM").is_ok_and(|p| p == "iTerm.app" || p == "WezTerm")
        || std::env::var("LC_TERMINAL").is_ok_and(|t| t == "iTerm2")
    {
        return ProtocolType::Iterm2;
    }
    if std::env::var("TERM").is_ok_and(|t| t == "foot" || t == "mlterm" || t.contains("sixel")) {
        return ProtocolType::Sixel;
    }
    ProtocolType::Halfblocks
}

/// Detects what the terminal can draw. We avoid querying stdin because doing
/// so on a background thread races with crossterm's event stream and drops
/// keystrokes at startup. Windows and tmux default to coloured half blocks;
/// Kitty/Ghostty/iTerm2/WezTerm are recognized from environment variables.
pub fn detect(setting: Option<&str>) -> Option<Picker> {
    let mode = mode(setting);
    if mode == Mode::Off {
        return None;
    }
    if cfg!(windows) {
        let mut picker = Picker::halfblocks();
        if let Mode::Force(protocol) = mode {
            picker.set_protocol_type(protocol);
        }
        return Some(picker);
    }
    let (fw, fh) = font_size();
    #[allow(deprecated)]
    let mut picker = Picker::from_fontsize((fw, fh));
    let protocol = match mode {
        Mode::Off => unreachable!(),
        Mode::Force(p) => p,
        Mode::Auto => guess_protocol(),
    };
    picker.set_protocol_type(protocol);
    Some(picker)
}

/// What a picture is up to.
#[derive(Debug, PartialEq, Eq)]
pub enum State {
    /// Not asked for (too old, or off).
    Absent,
    Decoding,
    Ready,
    Failed,
}

enum Slot {
    Decoding,
    Ready(StatefulProtocol),
    Failed,
}

pub struct Gallery {
    picker: Option<Picker>,
    slots: HashMap<String, Slot>,
    /// Ready ones, oldest first.
    order: VecDeque<String>,
}

impl Gallery {
    pub fn new(picker: Option<Picker>) -> Self {
        Self {
            picker,
            slots: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    pub fn enabled(&self) -> bool {
        self.picker.is_some()
    }

    /// What was chosen, for the status line.
    pub fn label(&self) -> &'static str {
        match self.picker.as_ref().map(Picker::protocol_type) {
            None => "off",
            Some(ProtocolType::Halfblocks) => "half blocks",
            Some(ProtocolType::Sixel) => "sixel",
            Some(ProtocolType::Kitty) => "kitty",
            Some(ProtocolType::Iterm2) => "iterm2",
        }
    }

    /// A cell's size in pixels, as far as the terminal says.
    pub fn font(&self) -> (u16, u16) {
        self.picker.as_ref().map_or((10, 20), Picker::font_size)
    }

    /// Pictures of the open conversation that still need decoding. They are
    /// marked as under way: ask once, hand each to a thread, then `finish`.
    pub fn wanted(&mut self, model: &Model) -> Vec<(String, Arc<Media>)> {
        if self.picker.is_none() {
            return Vec::new();
        }
        let Some(conv) = model.current.as_ref().and_then(|p| model.convs.get(p)) else {
            return Vec::new();
        };
        let mut asks = Vec::new();
        for msg in conv.msgs.iter().rev().filter(|m| m.image.is_some()).take(WANT) {
            if let Some(media) = &msg.image
                && !self.slots.contains_key(&msg.id)
            {
                self.slots.insert(msg.id.clone(), Slot::Decoding);
                asks.push((msg.id.clone(), media.clone()));
            }
        }
        asks
    }

    /// The pixels came back (or did not).
    pub fn finish(&mut self, id: String, decoded: Result<DynamicImage, String>) {
        let Some(picker) = &self.picker else {
            return;
        };
        match decoded {
            Ok(image) => {
                self.slots
                    .insert(id.clone(), Slot::Ready(picker.new_resize_protocol(image)));
                self.order.push_back(id);
            }
            Err(_) => {
                self.slots.insert(id.clone(), Slot::Failed);
                self.order.push_back(id);
            }
        }
        while self.order.len() > KEEP {
            if let Some(old) = self.order.pop_front() {
                self.slots.remove(&old);
            }
        }
    }

    /// Drops all decoded textures when switching conversations.
    pub fn clear_cache(&mut self) {
        self.slots.clear();
        self.order.clear();
    }

    pub fn state(&self, id: &str) -> State {
        match self.slots.get(id) {
            None => State::Absent,
            Some(Slot::Decoding) => State::Decoding,
            Some(Slot::Ready(_)) => State::Ready,
            Some(Slot::Failed) => State::Failed,
        }
    }

    pub fn protocol(&mut self, id: &str) -> Option<&mut StatefulProtocol> {
        match self.slots.get_mut(id) {
            Some(Slot::Ready(protocol)) => Some(protocol),
            _ => None,
        }
    }
}

/// The cells a `w`×`h` picture takes, no larger than `max_cols`×`max_rows` and
/// not upscaled, in its own proportions. `font` is a cell's size in pixels.
pub fn cells(w: u32, h: u32, font: (u16, u16), max_cols: usize, max_rows: usize) -> (usize, usize) {
    let (fw, fh) = (u64::from(font.0.max(1)), u64::from(font.1.max(1)));
    let (w, h) = (u64::from(w.max(1)), u64::from(h.max(1)));
    let to_usize = |n: u64| usize::try_from(n).unwrap_or(usize::MAX);
    let nat_cols = w.div_ceil(fw);
    let nat_rows = h.div_ceil(fh);
    let (max_c, max_r) = (u64::try_from(max_cols).unwrap_or(1).max(1), u64::try_from(max_rows).unwrap_or(1).max(1));
    if nat_cols <= max_c && nat_rows <= max_r {
        return (to_usize(nat_cols.max(1)), to_usize(nat_rows.max(1)));
    }
    // Whichever side runs out first sets the scale.
    if nat_cols * max_r >= nat_rows * max_c {
        (to_usize(max_c), to_usize((nat_rows * max_c).div_ceil(nat_cols).clamp(1, max_r)))
    } else {
        (to_usize((nat_cols * max_r).div_ceil(nat_rows).clamp(1, max_c)), to_usize(max_r))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_setting_picks_a_mode() {
        assert_eq!(mode(None), Mode::Auto);
        assert_eq!(mode(Some("auto")), Mode::Auto);
        assert_eq!(mode(Some("OFF")), Mode::Off);
        assert_eq!(mode(Some("0")), Mode::Off);
        assert_eq!(mode(Some("kitty")), Mode::Force(ProtocolType::Kitty));
        assert_eq!(mode(Some(" Sixel ")), Mode::Force(ProtocolType::Sixel));
        assert_eq!(mode(Some("iterm2")), Mode::Force(ProtocolType::Iterm2));
        assert_eq!(mode(Some("halfblocks")), Mode::Force(ProtocolType::Halfblocks));
        assert!(detect(Some("off")).is_none());
        assert_eq!(detect(Some("halfblocks")).map(|p| p.protocol_type()), Some(ProtocolType::Halfblocks));
        assert_eq!(detect(Some("kitty")).map(|p| p.protocol_type()), Some(ProtocolType::Kitty));
        assert_eq!(detect(Some("sixel")).map(|p| p.protocol_type()), Some(ProtocolType::Sixel));
        assert_eq!(detect(Some("iterm2")).map(|p| p.protocol_type()), Some(ProtocolType::Iterm2));
        assert!(detect(None).is_some());
    }

    #[test]
    fn pictures_keep_their_shape_inside_the_box() {
        let font = (10, 20);
        // Small: as it is.
        assert_eq!(cells(64, 64, font, 60, 14), (7, 4));
        // Wide and large: limited by the width.
        assert_eq!(cells(2000, 500, font, 60, 14), (60, 8));
        // Tall: limited by the height, narrow.
        let (c, r) = cells(500, 2000, font, 60, 14);
        assert_eq!(r, 14);
        assert_eq!(c, 7, "14 rows of 20 px are 280 px tall; at 1:4 that is 70 px wide, 7 cells of 10");
        // Never zero, never over the box, whatever the input.
        for (w, h) in [(1, 1), (1, 9000), (9000, 1), (8192, 8192)] {
            let (c, r) = cells(w, h, font, 60, 14);
            assert!((1..=60).contains(&c) && (1..=14).contains(&r), "{w}x{h}: {c}x{r}");
        }
        assert_eq!(cells(10, 10, (0, 0), 5, 5).0.min(5), 5, "a zero font size is tolerated");
    }

    fn model_with_pictures(n: usize) -> Model {
        let mut model = Model::new(Some("bob".into()), true, || 1, || "m".into());
        model.on_server(&json!({"k": "ready", "self": {"login": "alice"},
            "users": [{"login": "bob", "name": "Bob", "online": true}]}));
        let image = Media::from_bytes(crate::media::test_png(8, 8)).expect("png").to_value();
        let records: Vec<_> = (0..n)
            .map(|i| json!({"id": format!("p{i}"), "from": "bob", "text": "", "ts": i, "image": image}))
            .collect();
        model.on_history("bob", Ok(json!({"messages": records})));
        model
    }

    #[test]
    fn only_the_newest_pictures_are_decoded_and_each_only_once() {
        let model = model_with_pictures(40);
        let mut gallery = Gallery::new(Some(Picker::halfblocks()));
        let asks = gallery.wanted(&model);
        assert_eq!(asks.len(), WANT);
        assert_eq!(asks[0].0, "p39", "newest first");
        assert_eq!(gallery.state("p39"), State::Decoding);
        assert_eq!(gallery.state("p0"), State::Absent, "too old to be decoded");
        assert!(gallery.wanted(&model).is_empty(), "already under way");

        let image = asks[0].1.decode(DECODE_SIDE).expect("decodes");
        gallery.finish("p39".to_owned(), Ok(image));
        assert_eq!(gallery.state("p39"), State::Ready);
        assert!(gallery.protocol("p39").is_some());
        gallery.finish("p38".to_owned(), Err("damaged".to_owned()));
        assert_eq!(gallery.state("p38"), State::Failed);
        assert!(gallery.protocol("p38").is_none());
        assert!(gallery.wanted(&model).is_empty(), "a failure is not retried");
    }

    #[test]
    fn the_cache_evicts_the_oldest_ready_picture_and_never_refetches_what_it_dropped() {
        let model = model_with_pictures(40);
        let mut gallery = Gallery::new(Some(Picker::halfblocks()));
        let asks = gallery.wanted(&model);
        let image = asks[0].1.decode(DECODE_SIDE).expect("decodes");
        for i in 0..=KEEP {
            gallery.finish(format!("x{i}"), Ok(image.clone()));
        }
        assert_eq!(gallery.state("x0"), State::Absent, "evicted");
        assert_eq!(gallery.state(&format!("x{KEEP}")), State::Ready);
        // Off: nothing is wanted at all.
        let mut off = Gallery::new(None);
        assert!(off.wanted(&model).is_empty());
        assert!(!off.enabled());
    }
}
