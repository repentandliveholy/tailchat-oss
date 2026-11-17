// Cloud media is delivered inline and retained in account history. Ten MiB of
// base64 carries roughly a four-minute browser Opus recording or a
// full-resolution phone photo.
export const CLOUD_MEDIA_MAX_CHARS = 10 * 1024 * 1024;
export const CLOUD_FRAME_MAX_CHARS = CLOUD_MEDIA_MAX_CHARS + 1024;
export const CLOUD_WS_MAX_PAYLOAD = CLOUD_FRAME_MAX_CHARS + 64 * 1024;
// An end-to-end encrypted message carries its attachment inside one Megolm
// ciphertext together with the text, plus the cipher's MAC and signature
// (docs/specs/2026-11-04-e2ee.md §4.3). This is the room for that tail, and it
// has to stay inside the WebSocket headroom above or the socket drops the
// frame before the hub can answer it.
export const CLOUD_E2EE_FRAME_MAX_CHARS = CLOUD_FRAME_MAX_CHARS + 16 * 1024;
// A single conversation's inline media, all of which sits in `accounts.json`
// and therefore in memory and in every atomic rewrite of that file. The
// per-message ceiling times HISTORY_LIMIT would be gigabytes; this is what the
// oldest attachments are evicted down to.
export const CLOUD_HISTORY_MEDIA_BUDGET_CHARS = 64 * 1024 * 1024;
// Saved Messages is never pruned, so its inline media cannot be evicted down
// to a budget the way a normal conversation's is. This ceiling decides when a
// *new* attachment is refused and kept as text only — nothing already saved is
// ever touched — and it is larger because this is the one place a person
// deliberately puts things in order to keep them.
export const CLOUD_SAVED_MEDIA_BUDGET_CHARS = 256 * 1024 * 1024;
// The offline queue is a replay buffer, never a place a message is dropped
// from: everything in it is already committed to history, so its size is
// bounded by evicting *attachments* from the oldest queued frames instead of
// evicting the frames themselves. The text of every queued message survives;
// its picture or voice note is re-fetched from `/api/history`, which still
// has it.
export const CLOUD_QUEUE_MEDIA_BUDGET_CHARS = 64 * 1024 * 1024;
// `GET /api/media` answers from memory, but each answer is a decoded copy of up
// to ~7.5 MiB held until the socket drains it. Past these, a request is told
// 429 at once rather than queued: the clients already pace themselves below
// both (docs/specs/2026-11-03-history-media-refs.md §6.3).
export const MEDIA_INFLIGHT_PER_ACCOUNT = 8;
export const MEDIA_INFLIGHT_TOTAL = 32;
