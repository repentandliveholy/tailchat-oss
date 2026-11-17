// Holds messages composed while the peer is unreachable so they go out, in
// order, as soon as a channel is established again.
export function createOutbox(limit = 500) {
  const items = [];

  return {
    add(text, ts = Date.now(), id = null) {
      items.push({ text, ts, id });
      // Bound the queue: an unreachable peer must not grow memory without end.
      if (items.length > limit) items.splice(0, items.length - limit);
      return items.length;
    },

    size() {
      return items.length;
    },

    pending() {
      return items.map((item) => ({ ...item }));
    },

    /**
     * Drops one entry by id.
     *
     * The counterpart of [flush] for a transport where a successful write is not
     * the end of a message: over the cloud the server has to say it committed
     * the message (`message-accepted`), so the entry has to survive the write
     * and leave only on that receipt — or on the peer's own ack, which proves
     * the same thing. Returns whether anything was removed, so a caller can tell
     * a first acceptance from a duplicate one.
     */
    remove(id) {
      if (typeof id !== 'string' || id === '') return false;
      const at = items.findIndex((item) => item.id === id);
      if (at < 0) return false;
      items.splice(at, 1);
      return true;
    },

    // `send` returns false when the link died again; the untried remainder
    // stays queued so nothing is delivered twice or silently dropped.
    flush(send) {
      let delivered = 0;
      while (items.length > 0) {
        const { text, ts, id } = items[0];
        if (!send(text, ts, id)) break;
        items.shift();
        delivered++;
      }
      return delivered;
    },
  };
}
