# tcc

A terminal client for Tailchat cloud, in Rust. One binary, no database; the only
thing it keeps on disk is the token `tcc login` saves.

```
cargo install --path crates/tcc --locked     # or: cargo build --release -p tcc
tcc login            # password prompt (not echoed); token -> ~/.tailchat/tcc.json (0600)
tcc                  # the chat screen
tcc bob              # ...opened on a conversation   (tcc @who for a contact named like a command)
tcc who              # the roster, once
tcc send bob "hi"    # one message; `echo hi | tcc send bob` reads stdin, one message per line
tcc logout
```

The token comes from `TCC_TOKEN`, else `tcc login`, else the full client's login
(`TAILCHAT_CLOUD_TOKEN` in `~/.tailchat/secrets.env`; only that line is read). The
server: `-s/--server`, `TCC_SERVER`, `TAILCHAT_CLOUD_SERVER`, what the credentials
came with, `~/.tailchat/config.json`, then `https://repentandliveholy.org`.

## The screen

Roster on the left (people first, online before away, a badge for unread), the open
conversation on the right, one line to type in, one line of status. Under 56 columns
the roster hides; Tab still switches conversations. `NO_COLOR` is honoured.

| Keys | |
|---|---|
| Enter / Alt-Enter | send / new line |
| Tab, Shift-Tab, Ctrl-N, Ctrl-P, Alt-Up/Down | next / previous conversation |
| PgUp, PgDn | scroll the conversation |
| Up, Down | earlier / later sent lines |
| Ctrl-A/E, Home/End, Ctrl/Alt-Left/Right, Ctrl-W/U/K, Esc | edit the line |
| Ctrl-C, Ctrl-D on an empty line | quit |

Commands: `/to <login>`, `/who`, `/edit <text>`, `/del [me] [n]`, `/react <emoji>`,
`/unreact <emoji>`, `/retry`, `/img <file> [caption]`, `/open [n]`, `/help`, `/quit`; `//text` sends a leading slash.

Receipts follow the project's ladder: `⧗` queued, `✓` sent, `✓✓` delivered, green `✓✓`
read, `⚠` refused by the server (`/retry`). Messages typed while offline stay `⧗` and go
out by themselves after the reconnect (the server de-duplicates by id).

## Pictures

Pictures (JPEG, PNG, GIF, WebP) are rendered in the transcript using coloured half blocks
by default, or graphical protocols (Kitty, Sixel, iTerm2) when supported or requested.
Controlled via `TCC_IMAGES=auto|off|halfblocks|kitty|sixel|iterm2`. `/open [n]` opens the
picture in the system viewer. Big pictures are automatically resized for the cloud.

## Not here (yet)

Voice and files show as `[voice]`/`[file]`; no calls; no end-to-end encryption; no registration (use the web app); older history than the last 100 messages is not paged in.

## Layout

`model.rs` all protocol and conversation state, no I/O (the unit tests live there);
`ui.rs` ratatui rendering; `net.rs` WebSocket + HTTP; `creds.rs` token and server;
`text.rs` wrapping and the line editor; `main.rs` arguments and the event loops.
