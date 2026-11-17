# Contributing

Thanks for looking. Tailchat is three clients and a server that must keep agreeing with
each other, so most rules here are about not letting them drift apart.

## Setup

- Node.js 22+, then `npm ci`.
- Rust (the version in `crates/rust-toolchain.toml`) for the core.
- JDK 17 and the Android SDK for `android/`.

## Tests that must pass

```bash
node --test
(cd crates && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings)
(cd android && ./gradlew testDebugUnitTest)
```

If you touch keyboard handling, menus or prompts in the terminal client, also run
`node --test test/wide-chars.test.js test/menu.test.js` and check by hand that one keypress
is one action.

## House rules

- **One surface, every client.** A change to something a person sees as one thing — a
  receipt mark, a presence line, a menu row — lands in the web client (`web/cloud/app.js` +
  `app.css`), Android (`android/…/CloudScreen.kt`) and the terminal (`src/ui.js`) in the
  same change, or the pull request says why a client has no such surface.
- **Check the neighbours.** Before changing something, list who else reads it (other
  clients, the history API, the service worker cache, stored data) and test those too.
- **Version bumps sync the cache-busters.** Bumping `package.json` means updating the
  `?v=` strings in `web/cloud/index.html` and `web/cloud/sw.js`, incrementing `CACHE_NAME`
  in `sw.js`, and the expected cache name in `test/cloud-sw.test.js`. The test catches a miss.
- **Never answer a control frame with a control frame** (`hello`, `ping`, `read`, `ack`,
  `typing`): that is how sockets end up in a feedback loop.
- **No new cryptography.** Encryption goes through the Rust core and vodozemac.

`AGENTS.md` holds the same rules in more detail, written for coding agents.

## Big files

`web/cloud/app.js`, `src/cli.js` and `CloudScreen.kt` are large. Search by the function
names used in specs and tests rather than reading top to bottom; splitting them into modules
is welcome as separate, behaviour-preserving pull requests.

## Reporting bugs

Use the issue templates. Security problems go through private reporting, see
[SECURITY.md](SECURITY.md).
