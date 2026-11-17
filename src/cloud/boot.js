import { createCloudApi, CloudApiError } from './api.js';
import {
  resolveCloudServer, readCloudToken, saveCloudToken, clearCloudToken,
  cloudSocketUrl, cloudWebUrl,
} from './config.js';
import { signIn, pickPeer, describeApiError } from './prompt.js';
import { loadOrCreateIdentity, saveCertificate } from '../identity.js';

// Everything the cloud session needs, gathered while the terminal is still plain
// text: the TUI takes the screen afterwards, and a password prompt or a menu
// inside it would fight the app's own blessed screen for the same terminal.
//
// Returns null when the run cannot continue — an unusable server address, a
// refused sign-in, nobody to talk to — having already said why. The caller
// exits; it has nothing to add.
export async function prepareCloud({
  args, config = {}, t, themed = true, persist = () => {}, stateDir,
  input = process.stdin, output = process.stdout, now = Date.now,
  requirePeer = true,
}) {
  const server = resolveCloudServer({ flag: args.cloudServer, config });
  if (!server) {
    output.write(`${t('cloud.serverBad', { server: String(args.cloudServer ?? config.cloudServer ?? '') })}\n`);
    return null;
  }
  const api = createCloudApi({ server, token: readCloudToken(stateDir) });

  let identity = null;
  if (stateDir) {
    try {
      identity = loadOrCreateIdentity(stateDir);
    } catch {
      identity = null;
    }
  }

  let self = null;
  if (api.token()) {
    try {
      self = await api.me();
    } catch (error) {
      if (!(error instanceof CloudApiError)) throw error;
      output.write(`${describeApiError(error, t)}\n`);
      // A token the server no longer knows is worse than no token: kept, it
      // fails the same way on every run. Dropped, the next step asks for a
      // password and the account works again.
      if (error.code === 'unknown_token') {
        clearCloudToken(stateDir);
        api.setToken(null);
      } else {
        return null;
      }
    }
  }

  let recoveryKey = null;
  if (!self) {
    const signed = await signIn({
      api,
      t,
      defaultName: config.cloudLogin || args.name || '',
      themed,
      pubKey: identity?.publicKey || null,
      input,
      output,
    });
    if (!signed) return null;
    self = signed.user;
    recoveryKey = signed.recoveryKey || null;
    saveCloudToken(stateDir, signed.token);
    if (signed.cert && stateDir) {
      try {
        saveCertificate(stateDir, signed.cert);
      } catch {}
    }
  }

  // Remembered so the next run needs neither flag nor password: the server that
  // worked and the account that worked on it.
  persist({ cloudServer: server, cloudLogin: self.login });

  let users;
  try {
    users = await api.users();
  } catch (error) {
    if (!(error instanceof CloudApiError)) throw error;
    output.write(`${describeApiError(error, t)}\n`);
    return null;
  }

  if (!requirePeer) {
    return {
      server,
      api,
      self,
      recoveryKey,
      peer: null,
      peerName: null,
      users,
      token: api.token(),
      socketUrl: cloudSocketUrl(server),
      webUrl: cloudWebUrl(server),
    };
  }

  let peer = args.peer ? String(args.peer).trim().toLowerCase() : null;
  if (peer && !users.some((user) => user.login === peer)) {
    output.write(`${t('cloud.peerUnknown', { peer })}\n`);
    peer = null;
  }
  if (!peer) peer = await pickPeer({ api, users, t, themed, now: now(), input, output });
  if (!peer) return null;

  try {
    users = await api.users();
  } catch {
    // keep previously fetched users
  }

  const record = users.find((user) => user.login === peer) ?? null;
  return {
    server,
    api,
    self,
    recoveryKey,
    peer,
    peerName: record?.name || peer,
    users,
    token: api.token(),
    socketUrl: cloudSocketUrl(server),
    webUrl: cloudWebUrl(server),
  };
}

// `--cloud-logout`: the token goes from this machine and from the server, so a
// borrowed laptop is not a standing invitation. A server that cannot be reached
// still loses the local copy — the alternative is being unable to sign out at all.
export async function logoutCloud({ args, config = {}, t, stateDir, output = process.stdout }) {
  const token = readCloudToken(stateDir);
  clearCloudToken(stateDir);
  const server = resolveCloudServer({ flag: args.cloudServer, config });
  if (token && server) {
    try {
      await createCloudApi({ server, token }).logout();
    } catch {
      // The local copy is gone either way, which is the part this machine owns.
    }
  }
  output.write(`${t('cloud.loggedOut')}\n`);
}
