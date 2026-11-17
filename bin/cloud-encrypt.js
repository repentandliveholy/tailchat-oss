#!/usr/bin/env node
import { migrateCloudStorage, initCloudStorage } from '../src/cloud/migrate-storage.js';

const args = process.argv.slice(2);
let isInit = false;
const options = {};
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--init') {
    isInit = true;
    continue;
  }
  if (['--source', '--target', '--key-file'].includes(args[i]) && args[i + 1]) {
    options[args[i].slice(2).replace('-file', 'File')] = args[i + 1];
    i += 1;
    continue;
  }
  process.stderr.write('Usage: node bin/cloud-encrypt.js --source OLD_DIR --target NEW_DIR --key-file KEY_FILE\n       node bin/cloud-encrypt.js --init --target NEW_DIR --key-file KEY_FILE\n');
  process.exit(2);
}

try {
  if (isInit) {
    const report = initCloudStorage(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\nEncrypted directory initialized. You can now start the service with TAILCHAT_CLOUD_MASTER_KEY_FILE.\n`);
  } else {
    const report = migrateCloudStorage(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\nOriginal source remains untouched. Verify paths, sizes and recovery backup before changing service configuration.\n`);
  }
} catch (error) {
  process.stderr.write(`Cloud operation refused: ${error.message}\n`);
  process.exitCode = 1;
}
