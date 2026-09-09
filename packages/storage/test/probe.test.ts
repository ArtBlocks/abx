import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {StorageBackend, StoredContent} from '../src/backend.ts';
import {checkArweaveBackend, checkCloudBackend, checkViaHealth, probeStorageBackend} from '../src/probe.ts';
import type {ArweaveConfig} from '../src/arweave.ts';
import type {CloudStorageConfig} from '../src/cloud.ts';

const FAKE_CLOUD_CFG: CloudStorageConfig = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  bucket: 'my-bucket',
  region: 'auto',
  accessKeyId: 'k',
  secretAccessKey: 's',
  publicBase: 'https://cdn.example.com',
};

// Minimal no-op StorageBackend fixture — only the fields a given test cares about are overridden;
// TypeScript still requires the required members, so stub them rather than casting the type away.
function fakeBackend(overrides: Partial<StorageBackend> & {id: string}): StorageBackend {
  return {
    put: async () => {},
    get: async () => null,
    has: async () => false,
    ...overrides,
  };
}

// ── checkViaHealth (fs / ipfs / anything with nothing more to add) ──────────────────────────────

test('checkViaHealth: reflects health() ok/detail verbatim', async () => {
  const backend = fakeBackend({id: 'ipfs', health: async () => ({ok: true, detail: 'kubo reachable'})});
  const result = await checkViaHealth(backend);
  assert.deepEqual(result, {backend: 'ipfs', ok: true, detail: 'kubo reachable'});
});

test('checkViaHealth: health() reporting false round-trips as ok:false', async () => {
  const backend = fakeBackend({id: 'ipfs', health: async () => ({ok: false, detail: 'PINATA_JWT not set'})});
  const result = await checkViaHealth(backend);
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'PINATA_JWT not set');
});

test('checkViaHealth: no health() at all → ok:true with a "no check defined" detail', async () => {
  const backend = fakeBackend({id: 'other'});
  const result = await checkViaHealth(backend);
  assert.equal(result.ok, true);
  assert.match(result.detail, /no check defined/);
});

test('checkViaHealth: a health() that never resolves times out rather than hanging', async () => {
  const backend = fakeBackend({id: 'ipfs', health: () => new Promise(() => {})});
  const result = await checkViaHealth(backend, {timeoutMs: 20});
  assert.equal(result.ok, false);
  assert.match(result.detail, /timed out after 20ms/);
});

test('checkViaHealth: a health() that throws is caught, not propagated', async () => {
  const backend = fakeBackend({
    id: 'ipfs',
    health: async () => {
      throw new Error('boom');
    },
  });
  const result = await checkViaHealth(backend);
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'boom');
});

test('probeStorageBackend dispatches fs to a real writability check (no network)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-probe-'));
  try {
    const result = await probeStorageBackend({backend: 'fs', dataDir: dir});
    assert.equal(result.backend, 'fs');
    assert.equal(result.ok, true);
    assert.match(result.detail, /writable/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

// ── checkCloudBackend ────────────────────────────────────────────────────────────────────────────

function fakeCloudStore(): {backend: StorageBackend; store: Map<string, StoredContent>} {
  const store = new Map<string, StoredContent>();
  const backend = fakeBackend({
    id: 'cloud',
    publicBase: 'https://cdn.example.com',
    putObject: async (key, content) => {
      store.set(key, content);
    },
    getObject: async (key) => store.get(key) ?? null,
  });
  return {backend, store};
}

function fetchStub(store: Map<string, StoredContent>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const key = url.replace('https://cdn.example.com/', '');
    const content = store.get(key);
    if (!content) return new Response(null, {status: 404});
    return new Response(content.bytes, {status: 200});
  }) as typeof fetch;
}

test('checkCloudBackend: no public base configured → refused before any network call', async () => {
  const backend = fakeBackend({id: 'cloud', putObject: async () => {}, getObject: async () => null});
  const result = await checkCloudBackend(backend, FAKE_CLOUD_CFG);
  assert.equal(result.ok, false);
  assert.match(result.detail, /no public read base/);
  // Even this early refusal names the API write target — it's derived from `cfg`, not the round trip.
  assert.equal(result.putUrl, 'https://acct.r2.cloudflarestorage.com/my-bucket/abx-probe/check.txt');
});

test('checkCloudBackend: PUT fails → reported, BOTH the API write target and the public URL are named for context', async () => {
  const backend = fakeBackend({
    id: 'cloud',
    publicBase: 'https://cdn.example.com',
    putObject: async () => {
      throw new Error('403 Forbidden');
    },
    getObject: async () => null,
  });
  const result = await checkCloudBackend(backend, FAKE_CLOUD_CFG);
  assert.equal(result.ok, false);
  assert.match(result.detail, /PUT via the API failed/);
  assert.match(result.detail, /403 Forbidden/);
  assert.equal(result.putUrl, 'https://acct.r2.cloudflarestorage.com/my-bucket/abx-probe/check.txt');
  assert.equal(result.publicUrl, 'https://cdn.example.com/abx-probe/check.txt');
});

test('checkCloudBackend: PUT succeeds but the public base 404s (the endpoint-vs-public-base trap) → refused, both URLs named', async () => {
  const {backend, store} = fakeCloudStore();
  void store; // PUT succeeds and writes here; the fetch stub below deliberately never serves it
  const result = await checkCloudBackend(backend, FAKE_CLOUD_CFG, {fetchFn: (async () => new Response(null, {status: 404})) as typeof fetch});
  assert.equal(result.ok, false);
  assert.match(result.detail, /GET via the public base failed \(404\)/);
  // This is the exact diagnosis a real R2 endpoint-vs-public-base mismatch needs: two different
  // hosts, both on screen, so the mismatch is visible instead of a bare "fetch failed".
  assert.equal(result.putUrl, 'https://acct.r2.cloudflarestorage.com/my-bucket/abx-probe/check.txt');
  assert.equal(result.publicUrl, 'https://cdn.example.com/abx-probe/check.txt');
});

test('checkCloudBackend: PUT then GET-via-public-base round-trips the same bytes → ok', async () => {
  const {backend, store} = fakeCloudStore();
  const result = await checkCloudBackend(backend, FAKE_CLOUD_CFG, {fetchFn: fetchStub(store)});
  assert.equal(result.ok, true);
  assert.match(result.detail, /round-trip ok/);
  assert.equal(result.publicUrl, 'https://cdn.example.com/abx-probe/check.txt');
});

test('checkCloudBackend: the public base serves DIFFERENT bytes than were PUT → refused', async () => {
  const {backend} = fakeCloudStore();
  const staleFetch = (async () => new Response(new TextEncoder().encode('stale content'), {status: 200})) as typeof fetch;
  const result = await checkCloudBackend(backend, FAKE_CLOUD_CFG, {fetchFn: staleFetch});
  assert.equal(result.ok, false);
  assert.match(result.detail, /different bytes/);
});

test('checkCloudBackend: no cfg given (e.g. resolved without CLI config merge) → still round-trips, just no putUrl to show', async () => {
  const {backend, store} = fakeCloudStore();
  const result = await checkCloudBackend(backend, undefined, {fetchFn: fetchStub(store)});
  assert.equal(result.ok, true);
  assert.equal(result.putUrl, undefined);
  assert.equal(result.publicUrl, 'https://cdn.example.com/abx-probe/check.txt');
});

// ── checkArweaveBackend (no paid upload — identity + balance only) ─────────────────────────────

test('checkArweaveBackend: no identity yet → reported, no balance attempted (nothing to check)', async () => {
  const backend = fakeBackend({id: 'arweave', health: async () => ({ok: true, detail: 'provider turbo · gateway https://arweave.net'})});
  const cfg: ArweaveConfig = {gateway: 'https://arweave.net'};
  const result = await checkArweaveBackend(backend, cfg);
  assert.equal(result.backend, 'arweave');
  assert.equal(result.ok, true);
  assert.match(result.detail, /no identity yet/);
});

test('checkArweaveBackend: an identity exists but the balance read fails → reported alongside the base health', async () => {
  const backend = fakeBackend({id: 'arweave', health: async () => ({ok: true, detail: 'provider turbo · gateway https://arweave.net'})});
  // A malformed JWK (no modulus) makes the Turbo client construction throw SYNCHRONOUSLY — this
  // exercises the balance-check-failed branch with zero network I/O, deterministically.
  const cfg: ArweaveConfig = {gateway: 'https://arweave.net', jwk: {} as ArweaveConfig['jwk']};
  const result = await checkArweaveBackend(backend, cfg);
  assert.equal(result.ok, true); // base health still stands; only the balance add-on failed
  assert.match(result.detail, /balance check failed/);
});

test('checkArweaveBackend: no cfg at all → falls back to the base health verbatim', async () => {
  const backend = fakeBackend({id: 'arweave', health: async () => ({ok: false, detail: 'gateway unreachable'})});
  const result = await checkArweaveBackend(backend, undefined);
  assert.deepEqual(result, {backend: 'arweave', ok: false, detail: 'gateway unreachable'});
});
