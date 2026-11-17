//! Pictures: `data:image/…;base64,…` out of a message and back into one.
//!
//! The cloud carries a picture inline as `{dataUrl, width, height}` (JPEG, PNG,
//! GIF or WebP, at most 8192 px a side and 10 MiB of data URL). Everything here
//! is defensive about it: a peer controls these bytes.

use std::io::Cursor;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use image::codecs::jpeg::JpegEncoder;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder as _, ImageFormat, ImageReader, Limits};
use serde_json::{Value, json};

/// The server's cap on one media payload, in characters of the data URL.
const MAX_DATA_URL_CHARS: usize = 10 * 1024 * 1024;
/// Room left under the server's frame cap for the rest of the frame.
const FRAME_SLACK: usize = 8 * 1024;
/// The server clamps dimensions here, and so do we.
const MAX_SIDE: u32 = 8192;
/// What decoding may allocate (capped to 64 MB to prevent runaway RSS).
const MAX_ALLOC: u64 = 64 * 1024 * 1024;
/// Files bigger than this are not even read.
const MAX_FILE: u64 = 64 * 1024 * 1024;
/// The longest the data-URL prefix can be (`data:image/jpeg;base64,`).
const PREFIX: usize = 24;
const UNSUPPORTED: &str = "not a supported image (JPEG, PNG, GIF or WebP)";

/// One picture, as sent: encoded bytes and what is known without decoding them.
#[derive(PartialEq, Eq)]
pub struct Media {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub ext: &'static str,
    /// As displayed: already swapped for a sideways EXIF orientation.
    pub width: u32,
    pub height: u32,
}

impl std::fmt::Debug for Media {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Media({} {}x{}, {} bytes)", self.mime, self.width, self.height, self.bytes.len())
    }
}

fn strict() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_ALLOC);
    limits
}

fn reader(bytes: &[u8], limits: Limits) -> Result<ImageReader<Cursor<&[u8]>>, String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    reader.limits(limits);
    Ok(reader)
}

fn swaps_sides(orientation: Orientation) -> bool {
    matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    )
}

/// What the data URL of `len` encoded bytes would weigh.
fn data_url_chars(len: usize) -> usize {
    PREFIX + len.div_ceil(3) * 4
}

fn fits(len: usize) -> bool {
    data_url_chars(len) <= MAX_DATA_URL_CHARS - FRAME_SLACK
}

impl Media {
    /// Checks that `bytes` are a picture the cloud accepts and reads its size
    /// from the header (no pixels are decoded).
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, String> {
        let (mime, ext, width, height) = {
            let reader = reader(&bytes, strict())?;
            let (mime, ext) = match reader.format() {
                Some(ImageFormat::Jpeg) => ("image/jpeg", "jpg"),
                Some(ImageFormat::Png) => ("image/png", "png"),
                Some(ImageFormat::Gif) => ("image/gif", "gif"),
                Some(ImageFormat::WebP) => ("image/webp", "webp"),
                _ => return Err(UNSUPPORTED.to_owned()),
            };
            let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
            let (mut width, mut height) = decoder.dimensions();
            if swaps_sides(decoder.orientation().unwrap_or(Orientation::NoTransforms)) {
                std::mem::swap(&mut width, &mut height);
            }
            (mime, ext, width, height)
        };
        Ok(Self { bytes, mime, ext, width, height })
    }

    /// The `image` object of a message, or `None` when it carries no usable
    /// picture (no data — the server dropped it —, another format, damage).
    pub fn from_value(value: &Value) -> Option<Self> {
        let url = value.get("dataUrl")?.as_str()?;
        let (head, body) = url.split_once(',')?;
        if !head.starts_with("data:image/") || !head.ends_with(";base64") {
            return None;
        }
        let bytes = STANDARD.decode(body.trim()).ok()?;
        Self::from_bytes(bytes).ok()
    }

    /// The `image` object of a frame.
    pub fn to_value(&self) -> Value {
        json!({
            "dataUrl": format!("data:{};base64,{}", self.mime, STANDARD.encode(&self.bytes)),
            "width": self.width,
            "height": self.height,
        })
    }

    /// Decodes the pixels (the way up, whatever EXIF says), at most `max_side`
    /// a side.
    pub fn decode(&self, max_side: u32) -> Result<DynamicImage, String> {
        decode_bytes(&self.bytes, strict(), max_side)
    }
}

fn decode_bytes(bytes: &[u8], limits: Limits, max_side: u32) -> Result<DynamicImage, String> {
    let budget = limits.max_alloc.unwrap_or(u64::MAX);
    let mut decoder = reader(bytes, limits)?
        .into_decoder()
        .map_err(|e| e.to_string())?;
    if decoder.total_bytes() > budget {
        return Err("the picture is too large to decode".to_owned());
    }
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    image.apply_orientation(orientation);
    if image.width() > max_side || image.height() > max_side {
        image = image.thumbnail(max_side, max_side);
    }
    Ok(image)
}

/// A picture too big for the cloud, as a smaller JPEG that fits.
fn shrink(bytes: &[u8]) -> Result<Media, String> {
    let image = decode_bytes(bytes, Limits::default(), 2560)?;
    for (side, quality) in [(2560, 85), (1600, 75), (1000, 65)] {
        let scaled = if image.width() > side || image.height() > side {
            image.thumbnail(side, side)
        } else {
            image.clone()
        };
        let mut out = Vec::new();
        DynamicImage::ImageRgb8(scaled.to_rgb8())
            .write_with_encoder(JpegEncoder::new_with_quality(&mut out, quality))
            .map_err(|e| e.to_string())?;
        if fits(out.len()) {
            return Media::from_bytes(out);
        }
    }
    Err("cannot make it small enough for the cloud (about 7 MB)".to_owned())
}

/// A picture from disk, ready to send. One that is too big (in bytes or in
/// pixels) is re-encoded smaller instead of refused.
pub fn load_file(path: &Path) -> Result<Media, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if meta.len() > MAX_FILE {
        return Err("that file is too big to read".to_owned());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if fits(bytes.len())
        && let Ok(media) = Media::from_bytes(bytes.clone())
    {
        return Ok(media);
    }
    shrink(&bytes).map_err(|reason| {
        // A file that is no picture at all says so, not "cannot decode".
        if reader(&bytes, Limits::default()).is_ok_and(|r| r.format().is_none()) {
            UNSUPPORTED.to_owned()
        } else {
            reason
        }
    })
}

/// A dropped path as terminals paste it: quoted, or with `\ ` escapes, or
/// starting with `~/`.
pub fn clean_path(raw: &str, home: Option<&Path>) -> std::path::PathBuf {
    let raw = raw.trim();
    let quoted = raw.len() >= 2
        && ((raw.starts_with('"') && raw.ends_with('"')) || (raw.starts_with('\'') && raw.ends_with('\'')));
    let raw = if quoted { raw.get(1..raw.len() - 1).unwrap_or(raw) } else { raw };
    let mut path = String::new();
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c == '\\' && !cfg!(windows) {
            if let Some(next) = chars.next() {
                path.push(next);
            }
        } else {
            path.push(c);
        }
    }
    match (path.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => path.into(),
    }
}

#[cfg(test)]
pub fn test_png(width: u32, height: u32) -> Vec<u8> {
    let image = image::RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([
            u8::try_from(x * 255 / width.max(1)).unwrap_or(255),
            u8::try_from(y * 255 / height.max(1)).unwrap_or(255),
            128,
        ])
    });
    let mut out = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .expect("png");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_url(bytes: &[u8], mime: &str) -> Value {
        json!({"dataUrl": format!("data:{mime};base64,{}", STANDARD.encode(bytes)), "width": 1, "height": 1})
    }

    #[test]
    fn a_picture_survives_the_round_trip_and_its_size_comes_from_the_header() {
        let media = Media::from_value(&data_url(&test_png(40, 30), "image/png")).expect("media");
        assert_eq!((media.width, media.height, media.mime, media.ext), (40, 30, "image/png", "png"));
        let again = Media::from_value(&media.to_value()).expect("media");
        assert_eq!(again, media);
        let pixels = media.decode(16).expect("pixels");
        assert!(pixels.width().max(pixels.height()) <= 16, "thumbnailed to the cap");
    }

    #[test]
    fn what_is_not_a_picture_is_refused_whatever_it_claims() {
        assert!(Media::from_value(&data_url(b"<script>alert(1)</script>", "image/png")).is_none());
        assert!(Media::from_value(&data_url(&test_png(4, 4), "audio/webm")).is_none());
        assert!(Media::from_value(&json!({"width": 4, "height": 4})).is_none(), "dropped by the server");
        assert!(Media::from_value(&json!({"dataUrl": "data:image/png;base64,!!!not base64"})).is_none());
        assert!(Media::from_value(&json!({"dataUrl": "no comma at all"})).is_none());
        assert_eq!(Media::from_bytes(b"GIF".to_vec()).unwrap_err(), UNSUPPORTED);
    }

    #[test]
    fn the_server_s_size_ceiling_is_ours_too() {
        assert!(fits(7 * 1024 * 1024));
        assert!(!fits(8 * 1024 * 1024));
        assert_eq!(data_url_chars(3), PREFIX + 4);
    }

    #[test]
    fn paths_as_terminals_paste_them() {
        let home = Path::new("/home/u");
        for (raw, want) in [
            ("/tmp/a.png", "/tmp/a.png"),
            ("'/tmp/my pic.png'", "/tmp/my pic.png"),
            ("\"/tmp/my pic.png\"", "/tmp/my pic.png"),
            ("/tmp/my\\ pic.png", "/tmp/my pic.png"),
            ("~/Pictures/a.png", "/home/u/Pictures/a.png"),
            ("  /tmp/a.png  ", "/tmp/a.png"),
        ] {
            assert_eq!(clean_path(raw, Some(home)), Path::new(want), "{raw}");
        }
    }

    #[test]
    fn files_load_and_oversized_ones_are_shrunk_not_refused() {
        let dir = std::env::temp_dir().join(format!("tcc-media-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let small = dir.join("small.png");
        std::fs::write(&small, test_png(20, 10)).expect("write");
        let media = load_file(&small).expect("loads");
        assert_eq!((media.width, media.height), (20, 10));

        // Noise does not compress: a PNG of it is far over the cloud's cap.
        let mut state = 0x2545_f491_u32;
        let noise = image::RgbImage::from_fn(1800, 1800, |_, _| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let [a, b, c, _] = state.to_be_bytes();
            image::Rgb([a, b, c])
        });
        let big = dir.join("big.png");
        noise.save(&big).expect("save");
        assert!(std::fs::metadata(&big).expect("meta").len() > 8 * 1024 * 1024);
        let shrunk = load_file(&big).expect("shrunk");
        assert_eq!(shrunk.mime, "image/jpeg");
        assert!(fits(shrunk.bytes.len()), "{} bytes", shrunk.bytes.len());

        let text = dir.join("notes.txt");
        std::fs::write(&text, "hello").expect("write");
        assert_eq!(load_file(&text).unwrap_err(), UNSUPPORTED);
        assert!(load_file(&dir.join("missing.png")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
