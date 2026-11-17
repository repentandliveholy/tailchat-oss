//! Where the token and the server address come from, and where `tcc login`
//! keeps them. Nothing here ever prints a token.

use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::Path;

use serde_json::{Value, json};

/// Where the project actually runs.
pub const DEFAULT_SERVER: &str = "https://repentandliveholy.org";
/// The name the full client keeps its token under in `secrets.env`.
const TOKEN_SECRET: &str = "TAILCHAT_CLOUD_TOKEN";
/// `tcc`'s own file, so signing in here never rewrites the full client's
/// `secrets.env` (which holds other keys as well).
const OWN_FILE: &str = "tcc.json";

/// A token, and the server it belongs to when something knows.
pub struct Credentials {
    pub token: String,
    pub server: Option<String>,
}

/// Last value wins, like the full client's own parser; `export NAME=…`, quotes
/// and comments are tolerated. Nothing but the named secret is looked at.
pub fn secret(text: &str, name: &str) -> Option<String> {
    let mut found = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let key = match key.strip_prefix("export") {
            Some(rest) if rest.starts_with(char::is_whitespace) => rest.trim_start(),
            _ => key,
        };
        if key != name {
            continue;
        }
        let value = value.trim();
        let quoted = value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')));
        let value = if quoted {
            value.get(1..value.len() - 1).unwrap_or("")
        } else {
            value
        };
        found = (!value.is_empty()).then(|| value.to_owned());
    }
    found
}

fn read(dir: Option<&Path>, name: &str) -> Option<String> {
    std::fs::read_to_string(dir?.join(name)).ok()
}

fn json_field(text: &str, key: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    let field = value.get(key)?.as_str()?;
    (!field.is_empty()).then(|| field.to_owned())
}

/// The server the full client was last pointed at.
pub fn config_server(dir: Option<&Path>) -> Option<String> {
    read(dir, "config.json").and_then(|t| json_field(&t, "cloudServer"))
}

/// The first token found: `TCC_TOKEN`, then what `tcc login` saved, then the
/// full client's.
pub fn load(env: impl Fn(&str) -> Option<String>, dir: Option<&Path>) -> Option<Credentials> {
    let saved_server = config_server(dir);
    if let Some(token) = env("TCC_TOKEN").filter(|t| !t.is_empty()) {
        return Some(Credentials {
            token,
            server: saved_server,
        });
    }
    if let Some(text) = read(dir, OWN_FILE)
        && let Some(token) = json_field(&text, "token")
    {
        return Some(Credentials {
            token,
            server: json_field(&text, "server"),
        });
    }
    let token = secret(&read(dir, "secrets.env")?, TOKEN_SECRET)?;
    Some(Credentials {
        token,
        server: saved_server,
    })
}

/// A flag-like override beats what the credentials know, which beats the default.
pub fn server(env: impl Fn(&str) -> Option<String>, hint: Option<&str>) -> String {
    env("TCC_SERVER")
        .or_else(|| env("TAILCHAT_CLOUD_SERVER"))
        .or_else(|| hint.map(str::to_owned))
        .unwrap_or_else(|| DEFAULT_SERVER.to_owned())
}

/// Saves a token for `tcc`, readable by this user only from the first byte.
pub fn save(dir: &Path, server: &str, token: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir)?;
    let temp = dir.join(format!("{OWN_FILE}.tmp"));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    file.write_all(json!({"server": server, "token": token}).to_string().as_bytes())?;
    file.sync_all()?;
    std::fs::rename(temp, dir.join(OWN_FILE))
}

/// Forgets what `save` kept; the server and the token it held, if any.
pub fn forget(dir: &Path) -> Option<(String, String)> {
    let text = read(Some(dir), OWN_FILE)?;
    let found = json_field(&text, "token").map(|token| {
        (json_field(&text, "server").unwrap_or_else(|| DEFAULT_SERVER.to_owned()), token)
    });
    std::fs::remove_file(dir.join(OWN_FILE)).ok()?;
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_with(files: &[(&str, &str)]) -> tempdir::Dir {
        tempdir::Dir::new(files)
    }

    /// A throwaway directory without a dependency for it.
    mod tempdir {
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicU64, Ordering};

        pub struct Dir(PathBuf);

        impl Dir {
            pub fn new(files: &[(&str, &str)]) -> Self {
                static N: AtomicU64 = AtomicU64::new(0);
                let path = std::env::temp_dir().join(format!(
                    "tcc-test-{}-{}",
                    std::process::id(),
                    N.fetch_add(1, Ordering::Relaxed)
                ));
                std::fs::create_dir_all(&path).expect("temp dir");
                for (name, text) in files {
                    std::fs::write(path.join(name), text).expect("file");
                }
                Self(path)
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn secret_reads_only_the_named_line_and_the_last_one_wins() {
        let text = "# comment\nOPENAI_API_KEY=sk-other\nexport TAILCHAT_CLOUD_TOKEN=old\n\
                    TAILCHAT_CLOUD_TOKEN = \"new\"\nTAILCHAT_CLOUD_TOKEN_X=nope\n";
        assert_eq!(secret(text, TOKEN_SECRET).as_deref(), Some("new"));
        assert_eq!(secret("TAILCHAT_CLOUD_TOKEN=\n", TOKEN_SECRET), None);
        assert_eq!(secret("# TAILCHAT_CLOUD_TOKEN=x\n", TOKEN_SECRET), None);
    }

    #[test]
    fn the_token_comes_from_the_env_then_tcc_then_the_full_client() {
        let dir = dir_with(&[
            ("tcc.json", r#"{"server":"https://own.example","token":"own"}"#),
            ("secrets.env", "TAILCHAT_CLOUD_TOKEN=theirs\n"),
            ("config.json", r#"{"cloudServer":"https://full.example"}"#),
        ]);
        let none = |_: &str| None;
        let from_own = load(none, Some(dir.path())).expect("credentials");
        assert_eq!((from_own.token.as_str(), from_own.server.as_deref()), ("own", Some("https://own.example")));

        let env = |name: &str| (name == "TCC_TOKEN").then(|| "fromenv".to_owned());
        let from_env = load(env, Some(dir.path())).expect("credentials");
        assert_eq!(from_env.token, "fromenv");
        assert_eq!(from_env.server.as_deref(), Some("https://full.example"));

        let only_full = dir_with(&[("secrets.env", "TAILCHAT_CLOUD_TOKEN=theirs\n")]);
        let theirs = load(none, Some(only_full.path())).expect("credentials");
        assert_eq!((theirs.token.as_str(), theirs.server.as_deref()), ("theirs", None));

        let empty = dir_with(&[]);
        assert!(load(none, Some(empty.path())).is_none());
        assert!(load(none, None).is_none());
    }

    #[test]
    fn the_server_prefers_what_was_said_last() {
        let env = |name: &str| (name == "TCC_SERVER").then(|| "https://flag.example".to_owned());
        assert_eq!(server(env, Some("https://hint.example")), "https://flag.example");
        assert_eq!(server(|_| None, Some("https://hint.example")), "https://hint.example");
        assert_eq!(server(|_| None, None), DEFAULT_SERVER);
    }

    #[test]
    fn a_saved_login_is_private_and_can_be_forgotten() {
        let dir = dir_with(&[]);
        let state = dir.path().join("state");
        save(&state, "https://x.example", "tok").expect("save");
        let loaded = load(|_| None, Some(&state)).expect("credentials");
        assert_eq!((loaded.token.as_str(), loaded.server.as_deref()), ("tok", Some("https://x.example")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(state.join(OWN_FILE)).expect("meta").permissions().mode();
            assert_eq!(mode & 0o077, 0, "group/other must have no access: {mode:o}");
        }
        assert_eq!(forget(&state), Some(("https://x.example".to_owned(), "tok".to_owned())));
        assert!(load(|_| None, Some(&state)).is_none());
        assert_eq!(forget(&state), None);
    }
}
