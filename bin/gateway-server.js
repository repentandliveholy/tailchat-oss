#!/usr/bin/env node
import { createGatewayService } from '../src/gateway-server.js';

const service = createGatewayService();
service.listen()
  .then(({ http: httpAddress, ssh: sshAddress }) => {
    process.stdout.write(`Tailchat gateway ready: web ${httpAddress.address}:${httpAddress.port}, SSH bridge ${sshAddress.address}:${sshAddress.port}\n`);
  })
  .catch((error) => {
    process.stderr.write(`Tailchat gateway failed: ${error.message}\n`);
    process.exitCode = 1;
  });

const shutdown = async () => {
  await service.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
