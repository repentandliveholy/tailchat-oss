import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readPeerLinks, linkPeer, unlinkPeer, resolveLinkedCloudLogin,
} from '../src/peer-links.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-peer-links-'));

test('a linked selector resolves to its Cloud login, an unlinked one to null', () => {
  const dir = tempDir();
  try {
    assert.equal(resolveLinkedCloudLogin(dir, 'roman@example.com'), null);
    assert.equal(linkPeer(dir, 'roman@example.com', 'roman-cloud'), true);
    assert.equal(resolveLinkedCloudLogin(dir, 'roman@example.com'), 'roman-cloud');
    // Case-insensitive on the selector side, exactly like roster lookups.
    assert.equal(resolveLinkedCloudLogin(dir, 'ROMAN@example.com'), 'roman-cloud');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unlinkPeer removes an existing link and reports whether one existed', () => {
  const dir = tempDir();
  try {
    assert.equal(unlinkPeer(dir, 'roman@example.com'), false, 'nothing to unlink yet');
    linkPeer(dir, 'roman@example.com', 'roman-cloud');
    assert.equal(unlinkPeer(dir, 'roman@example.com'), true);
    assert.equal(resolveLinkedCloudLogin(dir, 'roman@example.com'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('linkPeer overwrites a previous link for the same selector rather than duplicating it', () => {
  const dir = tempDir();
  try {
    linkPeer(dir, 'roman@example.com', 'roman-cloud-old');
    linkPeer(dir, 'roman@example.com', 'roman-cloud-new');
    assert.equal(resolveLinkedCloudLogin(dir, 'roman@example.com'), 'roman-cloud-new');
    assert.equal(Object.keys(readPeerLinks(dir).links).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('links persist across a fresh read of the same state directory', () => {
  const dir = tempDir();
  try {
    linkPeer(dir, 'alice@example.com', 'alice-cloud');
    linkPeer(dir, 'bob@example.com', 'bob-cloud');
    assert.deepEqual(readPeerLinks(dir).links, {
      'alice@example.com': 'alice-cloud',
      'bob@example.com': 'bob-cloud',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-mangled peer-links.json is treated as no links rather than a crash', () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'peer-links.json'), '{not json');
    assert.deepEqual(readPeerLinks(dir), { links: {} });
    assert.equal(resolveLinkedCloudLogin(dir, 'roman@example.com'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty or absent selector is refused rather than linked under a blank key', () => {
  const dir = tempDir();
  try {
    assert.equal(linkPeer(dir, '', 'roman-cloud'), false);
    assert.equal(linkPeer(dir, 'roman@example.com', ''), false);
    assert.deepEqual(readPeerLinks(dir).links, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
