#!/usr/bin/env node
import { createCloudService, defaultCloudDataDir } from '../src/cloud/server.js';

const dataDir = defaultCloudDataDir();
if (!process.env.TAILCHAT_CLOUD_MASTER_KEY_FILE) {
  process.stderr.write('Tailchat cloud failed: set TAILCHAT_CLOUD_MASTER_KEY_FILE to a 0600, 32-byte hex key file outside the data directory; offline migration is required for existing data.\n');
  process.exit(1);
}
const service = createCloudService({ dataDir });

service.listen()
  .then((address) => {
    const aiBridgeState = service.aiBridge?.enabled?.() ? 'enabled' : 'disabled';
    process.stdout.write(
      `Tailchat cloud ready: http ${address.address}:${address.port}, data ${dataDir}, ai-bridge: ${aiBridgeState}\n`,
    );
  })
  .catch((error) => {
    process.stderr.write(`Tailchat cloud failed: ${error.message}\n`);
    // A supervised service that stays alive after a failed bind looks healthy
    // while answering nothing, so the exit code has to say otherwise.
    process.exit(1);
  });

// Last-resort reporting: a rejection or exception nobody caught is written out
// with its stack before the process goes, so the supervisor's restart comes
// with a reason in the log instead of a silent gap.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`Tailchat cloud: unhandled rejection: ${reason?.stack || reason}\n`);
});
process.on('uncaughtException', (error) => {
  process.stderr.write(`Tailchat cloud: uncaught exception: ${error?.stack || error}\n`);
  process.exit(1);
});

// The journal is fsynced, so a cut-short close loses nothing already accepted;
// the deadline only stops a hung checkpoint from outliving the supervisor's
// own kill timeout without a word.
const SHUTDOWN_DEADLINE_MS = 20_000;
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => {
    process.stderr.write('Tailchat cloud: shutdown deadline passed, exiting\n');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref();
  try {
    await service.close();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`Tailchat cloud: shutdown failed: ${error?.stack || error}\n`);
    process.exit(1);
  }
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
