import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isTurboArweave, planTurboUpload, assessStorageReadiness, assessTurboFunds} from '../src/upload-readiness.ts';
import {ARWEAVE_FREE_UPLOAD_LIMIT} from '../src/arweave.ts';
import type {ResolveStorageOptions} from '../src/resolve.ts';

// ── isTurboArweave ────────────────────────────────────────────────────────────

test('isTurboArweave: true only for the arweave backend on the (default or explicit) turbo provider', () => {
  assert.equal(isTurboArweave({backend: 'arweave'}), true); // no provider set → defaults to turbo
  assert.equal(isTurboArweave({backend: 'arweave', arweave: {gateway: 'https://arweave.net', provider: 'turbo'}}), true);
  assert.equal(isTurboArweave({backend: 'arweave', arweave: {gateway: 'https://arweave.net', provider: 'http-bundler'}}), false);
  assert.equal(isTurboArweave({backend: 'ipfs'}), false);
  assert.equal(isTurboArweave({backend: 'fs'}), false);
  assert.equal(isTurboArweave({}), false);
});

// ── planTurboUpload — the free-vs-credit decision, local size only ───────────

test('planTurboUpload: null when the backend is not Turbo-Arweave — nothing to decide', () => {
  assert.equal(planTurboUpload({backend: 'ipfs'}, 1000), null);
  assert.equal(planTurboUpload({backend: 'arweave', arweave: {gateway: 'https://arweave.net', provider: 'http-bundler'}}, 1000), null);
});

test('planTurboUpload: under the free tier is not chargeable; at/over it is', () => {
  const opts: ResolveStorageOptions = {backend: 'arweave'};
  assert.deepEqual(planTurboUpload(opts, ARWEAVE_FREE_UPLOAD_LIMIT - 1), {chargeable: false, sizeKb: ((ARWEAVE_FREE_UPLOAD_LIMIT - 1) / 1024).toFixed(1)});
  assert.equal(planTurboUpload(opts, ARWEAVE_FREE_UPLOAD_LIMIT)!.chargeable, true); // >= the limit IS chargeable
  assert.equal(planTurboUpload(opts, ARWEAVE_FREE_UPLOAD_LIMIT + 1)!.chargeable, true);
});

// ── assessStorageReadiness — per-backend readiness facts ─────────────────────

test('assessStorageReadiness: arweave, every file under the free tier → overCount 0, no network call needed', async () => {
  const report = await assessStorageReadiness({backend: 'arweave'}, [1000, 2000, 500]);
  assert.deepEqual(report, {backend: 'arweave', overCount: 0, totalCount: 3, totalKb: Math.round(3500 / 1024), usd: null});
});

test('assessStorageReadiness: arweave with a chargeable file reports the count + total size (usd is best-effort)', async () => {
  const sizes = [ARWEAVE_FREE_UPLOAD_LIMIT + 50_000, 1000];
  const report = await assessStorageReadiness({backend: 'arweave'}, sizes);
  assert.equal(report.backend, 'arweave');
  if (report.backend === 'arweave') {
    assert.equal(report.overCount, 1);
    assert.equal(report.totalCount, 2);
    assert.equal(report.totalKb, Math.round(sizes.reduce((a, b) => a + b, 0) / 1024));
    assert.ok(report.usd === null || typeof report.usd === 'number'); // best-effort: null if the price API is unreachable
  }
});

test('assessStorageReadiness: ipfs pinata mode with no JWT is flagged; kubo mode never needs one', async () => {
  assert.deepEqual(await assessStorageReadiness({backend: 'ipfs', ipfs: {mode: 'pinata', gateway: 'https://gateway.pinata.cloud', apiUrl: '', pinataEndpoint: ''}}, []), {
    backend: 'ipfs',
    pinataMissingJwt: true,
  });
  assert.deepEqual(
    await assessStorageReadiness({backend: 'ipfs', ipfs: {mode: 'pinata', gateway: 'https://gateway.pinata.cloud', apiUrl: '', pinataEndpoint: '', pinataJwt: 'jwt'}}, []),
    {backend: 'ipfs', pinataMissingJwt: false},
  );
  assert.deepEqual(await assessStorageReadiness({backend: 'ipfs', ipfs: {mode: 'kubo', gateway: '', apiUrl: '', pinataEndpoint: ''}}, []), {
    backend: 'ipfs',
    pinataMissingJwt: false,
  });
});

test('assessStorageReadiness: cloud with no public base is flagged; with one it is not', async () => {
  assert.deepEqual(
    await assessStorageReadiness({backend: 'cloud', cloud: {endpoint: 'e', bucket: 'b', region: 'r', prefix: 'p', accessKeyId: 'k', secretAccessKey: 's'}}, []),
    {backend: 'cloud', missingPublicBase: true},
  );
  assert.deepEqual(
    await assessStorageReadiness(
      {backend: 'cloud', cloud: {endpoint: 'e', bucket: 'b', region: 'r', prefix: 'p', accessKeyId: 'k', secretAccessKey: 's', publicBase: 'https://cdn.example.com'}},
      [],
    ),
    {backend: 'cloud', missingPublicBase: false},
  );
});

test('assessStorageReadiness: fs (and anything unrecognized) has nothing to check', async () => {
  assert.deepEqual(await assessStorageReadiness({backend: 'fs'}, [1, 2, 3]), {backend: 'other'});
  assert.deepEqual(await assessStorageReadiness({}, []), {backend: 'other'});
});

// ── assessTurboFunds — the pre-upload funds decision ──────────────────────────

test('assessTurboFunds: nothing chargeable → null, without ever resolving a funding identity', async () => {
  // A config with NO identity at all would throw if funding were resolved — reaching null instead
  // proves the free-tier files never even try.
  const result = await assessTurboFunds({gateway: 'https://arweave.net'}, [1000, 2000]);
  assert.equal(result, null);
});

test('assessTurboFunds: a provider with no funding capability (http-bundler) surfaces that clearly', async () => {
  await assert.rejects(
    assessTurboFunds({gateway: 'https://arweave.net', provider: 'http-bundler'}, [ARWEAVE_FREE_UPLOAD_LIMIT + 1]),
    /http-bundler.*no prepaid balance/,
  );
});
