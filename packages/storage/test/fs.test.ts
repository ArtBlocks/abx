import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyAgainstHash} from '@artblocks/abx-sdk';
import {LocalFsBackend, hashContent} from '../src/index.js';

function freshBackend(): {backend: LocalFsBackend; cleanup: () => void} {
  const dir = mkdtempSync(join(tmpdir(), 'abx-content-'));
  return {backend: new LocalFsBackend(dir), cleanup: () => rmSync(dir, {recursive: true, force: true})};
}

const BYTES = new TextEncoder().encode('\x89PNG\r\n\x1a\n fake image bytes');

test('put/get round-trips bytes and content type, addressed by commitment hash', async () => {
  const {backend, cleanup} = freshBackend();
  try {
    const hash = hashContent(BYTES);
    await backend.put(hash, {bytes: BYTES, contentType: 'image/png'});
    const got = await backend.get(hash);
    assert.ok(got);
    assert.deepEqual(got.bytes, BYTES);
    assert.equal(got.contentType, 'image/png');
  } finally {
    cleanup();
  }
});

test('has() reflects presence; get() of an unknown hash is null', async () => {
  const {backend, cleanup} = freshBackend();
  try {
    const hash = hashContent(BYTES);
    assert.equal(await backend.has(hash), false);
    assert.equal(await backend.get(hash), null);
    await backend.put(hash, {bytes: BYTES, contentType: 'image/png'});
    assert.equal(await backend.has(hash), true);
  } finally {
    cleanup();
  }
});

test('health() reports the content dir as writable', async () => {
  const {backend, cleanup} = freshBackend();
  try {
    const h = await backend.health();
    assert.equal(h.ok, true);
  } finally {
    cleanup();
  }
});

test('stored bytes verify against the on-chain commitment they were keyed by', async () => {
  const {backend, cleanup} = freshBackend();
  try {
    const hash = hashContent(BYTES); // the value committed on-chain (image keccak256 field)
    await backend.put(hash, {bytes: BYTES, contentType: 'image/png'});
    const got = await backend.get(hash);
    assert.ok(got);
    // The token API path: re-hash served bytes, compare to the on-chain hash — zero trust in the server.
    assert.equal(verifyAgainstHash(got.bytes, {field: 'image', representation: 'keccak256', value: hash}), true);
  } finally {
    cleanup();
  }
});
