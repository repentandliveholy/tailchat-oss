# Tailchat Android APK (Trusted Web Activity)

Wraps `web/cloud/` — the browser client, same account/login as the terminal's
`--cloud` mode — as an installable Android app, using Google's [Trusted Web
Activity](https://developer.chrome.com/docs/android/trusted-web-activity)
approach via [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap). The
app is a thin native shell around Chrome; all UI and logic stay in
`web/cloud/` and update themselves the moment that's deployed, no APK rebuild
needed for anything except icon/name/package changes.

This is a separate thing from `android/` (the native Kotlin P2P client for
plain `tailchat` over Tailscale, no server account). Both can be installed on
the same phone at once — different package IDs, different apps, different
protocols. Pick this one for the cloud/friends-list chat; pick `android/` for
direct P2P to one Tailscale machine.

## Why notifications work with the app closed

`web/cloud/` registers a Web Push subscription (`app.js`
`subscribeWebPush()`) against the VAPID keypair the cloud server generates
and persists at `<data-dir>/vapid_key.json` (`src/cloud/push.js`). When
`src/cloud/hub.js` can't deliver a message to a live connection, it sends a
push through the subscription, which Chrome delivers via its own background
push service even with every tab and the TWA closed — the same mechanism
that powers desktop Chrome push notifications, not a native Android sender.
`enableNotifications: true` below (Notification Delegation) makes Chrome show
that push under the Tailchat app's own name/icon instead of Chrome's.

## One-time setup

### Signing key

```bash
mkdir -p ~/.tailchat-android && chmod 700 ~/.tailchat-android
openssl rand -hex 24 > /tmp/pw && KS_PASS=$(cat /tmp/pw)
keytool -genkeypair -v \
  -keystore ~/.tailchat-android/tailchat-release.keystore \
  -alias tailchat -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$KS_PASS" -keypass "$KS_PASS" \
  -dname "CN=Tailchat, OU=Tailchat, O=repentandliveholy.org, L=Unknown, ST=Unknown, C=US"
echo "TAILCHAT_ANDROID_KEYSTORE_PASSWORD=$KS_PASS" > ~/.tailchat-android/keystore.env
chmod 600 ~/.tailchat-android/keystore.env ~/.tailchat-android/tailchat-release.keystore
```

Kept **outside this repo** on purpose — it's a secret, and this repo is
public. Losing it means every future release needs a new package ID, because
Android refuses to install an update signed by a different key over an
existing install. Back it up somewhere durable; there is no recovery if it's
lost.

### Bubblewrap's own config

Bubblewrap wants a JDK 17 and an Android SDK; on this machine both already
exist (JDK: Android Studio's bundled JBR; SDK: `~/Library/Android/sdk`).
Point it at them once so `bubblewrap build` never runs its interactive
installer wizard:

```bash
mkdir -p ~/.bubblewrap
cat > ~/.bubblewrap/config.json << 'EOF'
{"jdkPath":"<JDK bundle root, NOT .../Contents/Home>","androidSdkPath":"<Android SDK root>"}
EOF
```

On macOS, Bubblewrap appends `/Contents/Home` itself — `jdkPath` must stop
one level above that, or `JAVA_HOME` ends up doubled and the build fails.

Bubblewrap also insists on a legacy `<sdk>/tools` or `<sdk>/bin` directory
that current `cmdline-tools`-only SDK installs don't have:

```bash
ln -sf "$ANDROID_HOME/cmdline-tools/latest/bin" "$ANDROID_HOME/bin"
```

## Building a release

```bash
cd android-twa
npm install
npm run generate-manifest   # fetches the live web manifest, writes app/twa-manifest.json
npm run scaffold            # generates the Android project from that manifest
source ~/.tailchat-android/keystore.env
export BUBBLEWRAP_KEYSTORE_PASSWORD="$TAILCHAT_ANDROID_KEYSTORE_PASSWORD"
export BUBBLEWRAP_KEY_PASSWORD="$TAILCHAT_ANDROID_KEYSTORE_PASSWORD"
npm run build                # ~3 min; runs gradle, zipaligns, signs
```

Output: `app/app-release-signed.apk` (install/update file) and
`app/app-release-bundle.aab` (Play Store bundle, unused here but produced for
free).

`generate-manifest.mjs` reads `appVersionName` from the root `package.json`
version and hardcodes `appVersionCode`. Bump `appVersionCode` in that script
for any release meant to be installable *over* a previous one — Android
ignores `appVersionName` for update eligibility, only `appVersionCode`.

## Shipping it — no longer done

Since Android 0.54.0 the APK behind `/tailchat/tailchat.apk` is the **native**
client (`android/`, package `net.tailchat.android`), not this wrapper. This
project stays for reference and for the Digital Asset Links below; do **not**
copy its output over the published file, or the site starts handing out the
WebView wrapper again:

```bash
# DON'T, unless you are deliberately going back to the wrapper:
# cp app/app-release-signed.apk ../web/cloud/tailchat.apk
# scp app/app-release-signed.apk ovh:/opt/tailchat/web/cloud/tailchat.apk
```

Publishing the native APK is documented in `../android/README.md`
(«Публикация APK для веб-версии»). `web/cloud/tailchat.apk` is gitignored (see
root `.gitignore`) — same reasoning as `web/cloud/tailchat.tar.gz`: a generated
binary that must never go stale relative to whichever commit is actually
deployed, so it isn't tracked and doesn't ride along with `git reset --hard`
during `bin/production-deploy.js`. It has to be scp'd again after every
rebuild. The web app links to it at `/tailchat/tailchat.apk` (auth screen and
the settings sheet) for install and for "update by re-downloading" — this is a
manual download, not a silent auto-update; there is no Play Store here to do
that. The wrapper's package id and signing key differ from the native app's,
so a phone that has the wrapper installed gets the native app *alongside* it.

## Digital Asset Links (removing the Chrome URL bar)

`web/cloud/well-known/assetlinks.json` (served by `src/cloud/server.js` at
`/.well-known/assetlinks.json`, proxied by the production Caddy config) tells
Chrome this domain vouches for the app, so the TWA opens full-screen instead
of as a Custom Tab with a visible address bar. It's keyed to the signing
certificate above:

```bash
keytool -list -v -keystore ~/.tailchat-android/tailchat-release.keystore \
  -alias tailchat -storepass "$TAILCHAT_ANDROID_KEYSTORE_PASSWORD" | grep SHA256:
```

That fingerprint (colon-separated hex) goes in
`sha256_cert_fingerprints`. It only changes if the signing key is ever
rotated, which should be never — see "Signing key" above.

## Rebuilding after a `web/cloud/` release

The APK itself rarely needs a rebuild — it just points Chrome at
`https://repentandliveholy.org/tailchat/`, so ordinary web client changes
(this whole push-notification feature included) show up on next launch with
no APK update at all. Rebuild only when `manifest.webmanifest` changes
(name, icons, colors) or `appVersionCode` needs bumping for another reason;
then repeat "Building a release" and "Shipping it" above.
