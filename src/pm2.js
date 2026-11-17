import { execFile, spawn } from 'node:child_process';

const MANAGED_APP_NAMES = ['tailchat', 'tailchat-headless', 'tailchat-daemon'];

export function isManagedPm2App(name) {
  return typeof name === 'string' && MANAGED_APP_NAMES.includes(name.toLowerCase());
}

export function pausePm2Daemon({
  exec = execFile,
  names = MANAGED_APP_NAMES,
  timeoutMs = 2000,
} = {}) {
  return new Promise((resolve) => {
    exec('pm2', ['jlist'], { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      try {
        const list = JSON.parse(stdout);
        if (!Array.isArray(list)) return resolve(null);
        const matched = list.find((app) =>
          app && typeof app.name === 'string' &&
          names.includes(app.name.toLowerCase()) &&
          app.pm2_env?.status === 'online'
        );
        if (!matched) return resolve(null);
        exec('pm2', ['stop', matched.name], { encoding: 'utf8', timeout: 3000 }, (stopErr) => {
          resolve(!stopErr ? matched.name : null);
        });
      } catch {
        resolve(null);
      }
    });
  });
}

export function resumePm2Daemon(name = 'tailchat', { spawnFn = spawn } = {}) {
  if (!name || typeof name !== 'string') return false;
  try {
    const child = spawnFn('pm2', ['start', name], { detached: true, stdio: 'ignore' });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
