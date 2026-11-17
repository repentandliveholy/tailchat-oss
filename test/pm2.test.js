import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isManagedPm2App, pausePm2Daemon, resumePm2Daemon } from '../src/pm2.js';

test('isManagedPm2App recognises tailchat process names', () => {
  assert.equal(isManagedPm2App('tailchat'), true);
  assert.equal(isManagedPm2App('TAILCHAT'), true);
  assert.equal(isManagedPm2App('tailchat-headless'), true);
  assert.equal(isManagedPm2App('tailchat-daemon'), true);
  assert.equal(isManagedPm2App('web-server'), false);
  assert.equal(isManagedPm2App(null), false);
});

test('pausePm2Daemon pauses online tailchat instance and returns name', async () => {
  const mockJlist = JSON.stringify([
    { name: 'web', pm2_env: { status: 'online' } },
    { name: 'tailchat', pm2_env: { status: 'online' } },
  ]);

  const calls = [];
  const mockExec = (cmd, args, _options, cb) => {
    calls.push({ cmd, args });
    if (args[0] === 'jlist') cb(null, mockJlist, '');
    else if (args[0] === 'stop') cb(null, '', '');
  };

  const paused = await pausePm2Daemon({ exec: mockExec });
  assert.equal(paused, 'tailchat');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['jlist']);
  assert.deepEqual(calls[1].args, ['stop', 'tailchat']);
});

test('pausePm2Daemon returns null if no PM2 or no online tailchat', async () => {
  const mockExecError = (_cmd, _args, _options, cb) => {
    cb(new Error('pm2 command not found'), '', '');
  };
  const res1 = await pausePm2Daemon({ exec: mockExecError });
  assert.equal(res1, null);

  const mockExecStopped = (_cmd, _args, _options, cb) => {
    cb(null, JSON.stringify([{ name: 'tailchat', pm2_env: { status: 'stopped' } }]), '');
  };
  const res2 = await pausePm2Daemon({ exec: mockExecStopped });
  assert.equal(res2, null);
});

test('resumePm2Daemon spawns pm2 start with unref', () => {
  let spawned = null;
  const mockSpawn = (cmd, args, options) => {
    spawned = { cmd, args, options, unrefCalled: false };
    return {
      unref: () => { spawned.unrefCalled = true; },
    };
  };

  const ok = resumePm2Daemon('tailchat', { spawnFn: mockSpawn });
  assert.equal(ok, true);
  assert.equal(spawned.cmd, 'pm2');
  assert.deepEqual(spawned.args, ['start', 'tailchat']);
  assert.equal(spawned.unrefCalled, true);
  assert.equal(resumePm2Daemon(''), false);
});
