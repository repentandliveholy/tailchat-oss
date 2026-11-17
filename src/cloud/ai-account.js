import crypto from 'node:crypto';

import { SERVICE_LOGIN } from './service-account.js';

// The assistant as a contact of its own.
//
// Until now the model answered *inside somebody else's conversation*: the
// reply was sent from the owner's account with `name: 'tailik'` on the frame,
// which meant there was no way to simply write to the assistant — you had to
// mention it in a chat with a human, and whether it answered depended on
// whether any terminal on either side had claimed the answering. A contact
// removes all of that: opening this thread is addressing the assistant, and
// nothing else shares it.
//
// Like the official account (`service-account.js`) it is a real account that
// nobody signs into: it exists so it can appear in a roster and own a
// conversation. Its password is random and thrown away.
export const AI_LOGIN = 'tailik';
export const AI_NAME = 'tailik';

const PASSWORD_BYTES = 32;

/** Idempotent: runs on every boot, creates the account at most once. */
export async function ensureAiAccount(store) {
  if (store.users().some((user) => user.login === AI_LOGIN)) return false;
  const result = await store.register({
    login: AI_LOGIN,
    name: AI_NAME,
    password: crypto.randomBytes(PASSWORD_BYTES).toString('hex'),
  });
  if (!result.ok) return false;
  // `register` hands out a session token; for an account nobody signs into
  // that is a standing session for no one.
  store.revokeToken(result.token);
  return true;
}

/** Puts the assistant in one account's roster. Cheap and idempotent. */
export function linkAiAccount(store, login) {
  // Neither server-side account is a contact of the other.
  if (!login || login === AI_LOGIN || login === SERVICE_LOGIN) return false;
  store.linkFriends(AI_LOGIN, login);
  return true;
}

/** Every existing account, at boot: a contact added after the fact must still
 *  reach people who registered before it existed. */
export function linkAiAccountToEveryone(store) {
  let linked = 0;
  for (const user of store.users()) {
    if (linkAiAccount(store, user.login)) linked += 1;
  }
  return linked;
}
