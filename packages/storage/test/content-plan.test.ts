import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decideImageContentLane, DIRECT_URL_BACKENDS, validateRenderStorageCombo} from '../src/content-plan.ts';

test('DIRECT_URL_BACKENDS: ipfs, arweave, and cloud can serve a public URL; fs cannot', () => {
  assert.ok(DIRECT_URL_BACKENDS.has('ipfs'));
  assert.ok(DIRECT_URL_BACKENDS.has('arweave'));
  assert.ok(DIRECT_URL_BACKENDS.has('cloud'));
  assert.equal(DIRECT_URL_BACKENDS.has('fs'), false);
});

test('decideImageContentLane: off-chain custody (the default) is always keccak, never a fallback warning', () => {
  assert.deepEqual(decideImageContentLane({onChain: false, isSvg: false, backendId: 'fs'}), {lane: 'keccak-custody', onchainFallback: false});
  // Even a direct-URL backend doesn't change the off-chain-metadata lane — that path is unrelated
  // to `--onchain-uri`; the on-chain-vs-off-chain lane decision is made by `onChain` alone.
  assert.deepEqual(decideImageContentLane({onChain: false, isSvg: false, backendId: 'arweave'}), {lane: 'keccak-custody', onchainFallback: false});
});

test('decideImageContentLane: --onchain-uri + SVG bytes always inlines, regardless of backend', () => {
  assert.deepEqual(decideImageContentLane({onChain: true, isSvg: true, backendId: 'fs'}), {lane: 'inline-svg', onchainFallback: false});
  assert.deepEqual(decideImageContentLane({onChain: true, isSvg: true, backendId: 'arweave'}), {lane: 'inline-svg', onchainFallback: false});
});

test('decideImageContentLane: --onchain-uri + a raster + a direct-URL backend bakes an on-chain URL, no fallback', () => {
  for (const backendId of ['ipfs', 'arweave', 'cloud']) {
    assert.deepEqual(
      decideImageContentLane({onChain: true, isSvg: false, backendId}),
      {lane: 'onchain-url', onchainFallback: false},
      `expected onchain-url for backend '${backendId}'`,
    );
  }
});

test('decideImageContentLane: --onchain-uri + a raster + fs (no public URL) falls back to keccak custody, flagged', () => {
  assert.deepEqual(decideImageContentLane({onChain: true, isSvg: false, backendId: 'fs'}), {lane: 'keccak-custody', onchainFallback: true});
});

// ── validateRenderStorageCombo ──────────────────────────────────────────────────────────────────
// combo #1 (--image-base) is checked against the URL's OWN shape, not this deploy's unrelated
// `--backend`/`ABX_STORAGE_BACKEND` — a real test caught this: a legit r2.dev `--image-base` on the
// DEFAULT `fs` backend (nobody had set `--backend cloud` at all) must NOT be refused, because
// `--image-base` names where the EFFECT RUNNER later writes stills (its own ABX_S3_* config),
// which is simply a different config surface than this deploy's own upload target.

test('validateRenderStorageCombo: no image-base, no remote publish → ok regardless of backend (nothing to check)', () => {
  for (const backendId of ['fs', 'ipfs', 'arweave', 'cloud']) {
    assert.deepEqual(validateRenderStorageCombo({backendId}), {ok: true}, `expected ok for backend '${backendId}'`);
  }
  assert.deepEqual(validateRenderStorageCombo({}), {ok: true}); // no backendId at all is fine too
});

test('validateRenderStorageCombo: a mutable bucket/CDN --image-base → ok, independent of --backend', () => {
  for (const backendId of ['fs', 'ipfs', 'arweave', 'cloud', undefined]) {
    assert.deepEqual(
      validateRenderStorageCombo({imageBaseUrl: 'https://pub-abc.r2.dev/orbit/{id}.png', backendId}),
      {ok: true},
      `expected ok for backend '${backendId}'`,
    );
  }
});

test('validateRenderStorageCombo: an ipfs-gateway-shaped --image-base is refused (combo #1) — regardless of --backend', () => {
  for (const url of ['https://ipfs.io/ipfs/bafybeigd.../{id}.png', 'ipfs://bafybeigd.../{id}.png', 'https://dweb.link/ipfs/bafybeigd.../{id}.png']) {
    const result = validateRenderStorageCombo({imageBaseUrl: url, backendId: 'fs'}); // fs — the exact case a real test caught
    assert.equal(result.ok, false, `expected refusal for '${url}'`);
    if (!result.ok) {
      assert.match(result.reason, /--image-base/);
      assert.match(result.reason, /content-addressed/);
    }
  }
});

test('validateRenderStorageCombo: an arweave-gateway-shaped --image-base is refused (combo #1)', () => {
  for (const url of ['https://arweave.net/txid.../{id}.png', 'ar://txid.../{id}.png']) {
    const result = validateRenderStorageCombo({imageBaseUrl: url});
    assert.equal(result.ok, false, `expected refusal for '${url}'`);
  }
});

test('validateRenderStorageCombo: publishing to a remote resolver on fs → refused (combo #2)', () => {
  const result = validateRenderStorageCombo({backendId: 'fs', publishesToRemoteResolver: true});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /can't produce a URL/);
    assert.match(result.reason, /co-located/);
  }
});

test('validateRenderStorageCombo: publishing to a remote resolver on ipfs/arweave → ok (both can name a URL)', () => {
  for (const backendId of ['ipfs', 'arweave']) {
    assert.deepEqual(
      validateRenderStorageCombo({backendId, publishesToRemoteResolver: true}),
      {ok: true},
      `expected ok for backend '${backendId}'`,
    );
  }
});

test('validateRenderStorageCombo: publishing to a remote resolver on cloud WITHOUT a public base → refused, named reason', () => {
  const result = validateRenderStorageCombo({backendId: 'cloud', publishesToRemoteResolver: true, cloudHasPublicBase: false});
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no public read base/);
});

test('validateRenderStorageCombo: publishing to a remote resolver on cloud WITH a public base → ok', () => {
  assert.deepEqual(
    validateRenderStorageCombo({backendId: 'cloud', publishesToRemoteResolver: true, cloudHasPublicBase: true}),
    {ok: true},
  );
});

test('validateRenderStorageCombo: not publishing remotely (co-located) → fs is fine even with no locator', () => {
  assert.deepEqual(validateRenderStorageCombo({backendId: 'fs', publishesToRemoteResolver: false}), {ok: true});
});

test('validateRenderStorageCombo: the image-base combo is checked before the remote-publish combo (one reason at a time)', () => {
  // Both could independently apply here (a bad image-base URL AND a locator-less backend), but the
  // image-base violation is checked first, so it's the one reported.
  const result = validateRenderStorageCombo({imageBaseUrl: 'https://arweave.net/x/{id}.png', backendId: 'fs', publishesToRemoteResolver: true});
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /--image-base/);
});
