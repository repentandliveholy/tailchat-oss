# termux-wrapper

A third way onto tailchat from a phone, next to `android/` (native Kotlin
reimplementation of the wire protocol) and `android-ssh-wrapper/` (SSH into a
host machine that runs tailchat for you). This one reimplements nothing: it
runs the real CLI (`src/cli.js`) inside Termux, the same code that runs on a
Mac or a Linux box, wrapped in one small addition Android specifically needs:
a `termux-wake-lock` around the process, because a long-lived listener like
this is exactly what Doze mode / phantom-process killing suspends the moment
the screen turns off — the session would otherwise die silently, mid-chat,
with nothing in the transcript to explain why. Everything else tailchat
already knows how to do on this platform — `isTermux()` detection,
`termux-notification` for alerts, `termux-clipboard-set` for copy, a
writable-shared-Downloads search for received files — this wrapper just
automates the fiddly one-time setup around that support, documented in full
(with the *why* for each step) in the main README's
["Termux, Android"](../README.md#termux-android) section.

## Why a script instead of just following the README

The manual steps are all one-offs that are easy to get subtly wrong or
forget one of:

1. Install Node ≥ 18 and git.
2. Notice that `pkg install tailscale` inside Termux is actively harmful
   (dead binary, no daemon to talk to — see the README section for what
   that used to break) and remove it if present.
3. Clone the repo and `npm install`.
4. Link the **`sh`-shebang** entry point (`bin/tailchat`, not
   `bin/tailchat.js`) as `tailchat` on `PATH` — the `env`-shebang one only
   works inside an interactive shell on Android, so linking the wrong one
   means `tailchat` runs fine by hand and then fails from anywhere else
   (cron, another app, a script).
5. Optionally install `termux-api` for notifications and run
   `termux-setup-storage` so received files land somewhere the gallery/share
   sheet can actually see.
6. Wrap that same entry point in [`launcher.sh`](launcher.sh) so it holds a
   `termux-wake-lock` for the life of the process — otherwise this exact
   kind of long-lived background listener is what Android suspends once the
   screen locks, and the chat just stops with no error to explain it.

`install.sh` does all six, in order, and is safe to re-run — it `git pull`s
an existing checkout and reinstalls deps rather than failing, so re-running
it is also how you update.

## Quick start

The repository is private (anonymous `GET` on both the web page and the API
returns 404), so the `git clone` below needs a credential that already has
read access: `gh auth login` or a PAT entered once on the target device
(`credential.helper=store` remembers it after that, as it already does on
the phone this was written for), or an entirely different source via
`--repo`/`TAILCHAT_REPO`. The GitHub-free path actually proven to work: on
a machine that already has the commits, `git bundle create sync.bundle
<ref-the-target-already-has>..HEAD`, pipe it over an existing SSH
connection (`cat sync.bundle | ssh <target> 'cat > sync.bundle'`), then on
the target `git fetch sync.bundle HEAD:refs/heads/sync && git merge
--ff-only sync` — this is exactly how this phone got today's commits before
origin had them, twice, both a clean fast-forward. A same-tailnet dumb-HTTP
clone (`git update-server-info` + `python -m http.server`) was tried
instead and rejected: it needs the source machine listening at the exact
moment of the clone, leaves a private checkout reachable unauthenticated on
the tailnet for as long as it runs, and still hung for 5 minutes without
transferring a single object.

Tailscale app installed and signed in on the phone first (this script never
touches it — routing and MagicDNS are all tailchat needs from it). Then, in
Termux:

```bash
bash termux-wrapper/install.sh
```

or, without cloning by hand first:

```bash
pkg install -y git && \
git clone https://github.com/repentandliveholy/tailchat-oss.git && \
bash tailchat/termux-wrapper/install.sh
```

Then from anywhere in Termux:

```bash
tailchat desktop-iru.tailc80816.ts.net
```

(MagicDNS name or a `100.x` address for the first call to any given peer —
no local `tailscaled` here to resolve a login to a device list. After the
first successful session the short remembered name works too.)

## Flags

```
install.sh [--dir PATH] [--repo URL] [--no-api] [--no-storage] [-h]
```

- `--dir PATH` — checkout location (default `~/tailchat`).
- `--repo URL` — git remote to clone/pull (default upstream).
- `--no-api` — skip `pkg install termux-api`; notifications fall back to the
  bell (this is also what happens automatically on the Google Play build of
  Termux, which ships without the Termux:API bridge app regardless).
- `--no-storage` — skip `termux-setup-storage`; received files stay inside
  the checkout instead of the shared Downloads folder.

## What it deliberately does not do

- Does not touch the Tailscale Android app, its login, or its ACLs.
- Does not publish anything, open any port, or change any tailnet setting —
  it only installs packages, clones/updates a git checkout, and symlinks one
  launcher inside Termux's own `$PREFIX/bin`.
- Refuses to run outside Termux (checks `$PREFIX` for a `com.termux` path)
  rather than risk the `pkg`-specific steps against a real Debian/Ubuntu box.
