// PM2 process file for a self-hosted Tailchat cloud. Copy it, set your own
// paths and addresses, then: pm2 startOrReload ecosystem.config.cjs --update-env
// Every variable is described in README.md ("Hosting a server").
module.exports = {
  apps: [
    {
      name: 'tailchat-gateway',
      script: './bin/gateway-server.js',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      watch: false,
      max_memory_restart: '150M',
      env: {
        NODE_ENV: 'production',
        TAILCHAT_GATEWAY_HOST: '127.0.0.1',
        TAILCHAT_GATEWAY_PORT: '7681',
        TAILCHAT_GATEWAY_SSH_HOST: '127.0.0.1',
        TAILCHAT_GATEWAY_SSH_PORT: '7682',
      },
    },
    {
      name: 'tailchat-cloud',
      script: './bin/cloud-server.js',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      watch: false,
      // The server keeps the whole store in memory and rewrites it on every
      // checkpoint; leave several times the steady RSS as headroom.
      max_memory_restart: '1536M',
      env: {
        NODE_ENV: 'production',
        TAILCHAT_CLOUD_HOST: '127.0.0.1',
        TAILCHAT_CLOUD_PORT: '7683',
        TAILCHAT_CLOUD_DATA: '/var/lib/tailchat-cloud',
        TAILCHAT_CLOUD_MASTER_KEY_FILE: '/etc/tailchat-cloud/master.key',
        // Only behind a reverse proxy that sets X-Forwarded-For/-Host itself.
        TAILCHAT_CLOUD_TRUST_PROXY: '1',
        // Your coturn's public address (STUN, and TURN with turn_secret in the
        // data directory). Unset: public STUN only, no relay.
        // TAILCHAT_CLOUD_TURN_HOST: '203.0.113.10',
        // In-app bug reports go to issues of this repository (needs a token).
        // TAILCHAT_GITHUB_REPO: 'owner/repo',
      },
    },
  ],
};
