import {test} from 'node:test';
import assert from 'node:assert/strict';
import {awaitLocatorReady, gatewayUrlFor, locatorStatus, parseLocator, probeGateway, resolveGatewayBase} from '../src/readiness.js';

const CID = 'bafybeiephmsx65ezq3mqxhkcrjsadgeipvg4bsb5ngenbxognechc32qaq';
const TXID = 'lZQ9gm4EPPKCkxLLuvKMLPBpxUtHkzHqRTdyEBQBgYs';

/** A fetch that answers per-host from a table. `undefined` ⇒ the request never completes. */
function fakeFetch(byHost: Record<string, {status: number; headers?: Record<string, string>} | undefined>) {
  const asked: string[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    asked.push(u);
    // Every probe must be ranged — otherwise checking a 40 MB asset downloads it.
    assert.equal((init?.headers as Record<string, string>)?.range, 'bytes=0-0');
    const answer = byHost[new URL(u).host];
    if (!answer) throw Object.assign(new Error('aborted'), {name: 'AbortError'});
    return {
      status: answer.status,
      headers: new Headers(answer.headers ?? {}),
      body: null,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return {fn, asked};
}

const serving = {status: 206, headers: {'content-type': 'image/png', 'content-range': 'bytes 0-0/230596'}};
const missing = {status: 404};

// ── parsing ───────────────────────────────────────────────────────────────────

test('parseLocator: every form a locator actually arrives in', () => {
  assert.deepEqual(parseLocator(`ar://${TXID}`), {network: 'arweave', id: TXID});
  assert.deepEqual(parseLocator(`ipfs://${CID}`), {network: 'ipfs', id: CID});
  // A path suffix rides along — a directory manifest entry is the common case for a Series.
  assert.deepEqual(parseLocator(`ipfs://${CID}/0.png`), {network: 'ipfs', id: `${CID}/0.png`});
  // Bare ids: 43 base64url chars is an Arweave txid; a CID is recognised by its multibase prefix.
  assert.deepEqual(parseLocator(TXID), {network: 'arweave', id: TXID});
  assert.equal(parseLocator(CID).network, 'ipfs');
  // An absolute URL keeps its own gateway but still classifies, so the alternates can apply.
  assert.deepEqual(parseLocator(`https://arweave.net/${TXID}`), {network: 'arweave', id: `https://arweave.net/${TXID}`});
  assert.equal(parseLocator(`https://gateway.pinata.cloud/ipfs/${CID}`).network, 'ipfs');
  assert.equal(parseLocator('https://cdn.example.com/art.png').network, 'http');
});

test('parseLocator: an unrecognisable value is a clear error, not a silent guess', () => {
  assert.throws(() => parseLocator('not-a-locator'), /isn't a recognisable locator/);
});

test('gatewayUrlFor: ipfs gets /ipfs/, arweave gets the bare path, an absolute URL is untouched', () => {
  assert.equal(gatewayUrlFor('ipfs', CID, 'https://ipfs.io/'), `https://ipfs.io/ipfs/${CID}`);
  assert.equal(gatewayUrlFor('arweave', TXID, 'https://arweave.net'), `https://arweave.net/${TXID}`);
  // Rewriting a URL someone handed us would answer a question they didn't ask.
  assert.equal(gatewayUrlFor('arweave', 'https://custom.gw/x', 'https://arweave.net'), 'https://custom.gw/x');
});

// ── resolveGatewayBase: override → env → generic public default ───────────────────
// The one function every "turn a stored locator into a fetchable URL" caller shares —
// token-api's resolveLocatorUrl/codeLocatorUrl consume this instead of each re-deriving the
// same override/env/default line.

test('resolveGatewayBase: an explicit override wins outright, no env involved', () => {
  const prev = process.env.ABX_IPFS_GATEWAY;
  process.env.ABX_IPFS_GATEWAY = 'https://env.example';
  try {
    assert.equal(resolveGatewayBase('ipfs', 'https://override.example'), 'https://override.example');
  } finally {
    if (prev === undefined) delete process.env.ABX_IPFS_GATEWAY;
    else process.env.ABX_IPFS_GATEWAY = prev;
  }
});

test('resolveGatewayBase: no override → the network env var wins', () => {
  const prevIpfs = process.env.ABX_IPFS_GATEWAY;
  const prevAr = process.env.ABX_ARWEAVE_GATEWAY;
  process.env.ABX_IPFS_GATEWAY = 'https://my-ipfs.example';
  process.env.ABX_ARWEAVE_GATEWAY = 'https://my-arweave.example';
  try {
    assert.equal(resolveGatewayBase('ipfs'), 'https://my-ipfs.example');
    assert.equal(resolveGatewayBase('arweave'), 'https://my-arweave.example');
  } finally {
    if (prevIpfs === undefined) delete process.env.ABX_IPFS_GATEWAY;
    else process.env.ABX_IPFS_GATEWAY = prevIpfs;
    if (prevAr === undefined) delete process.env.ABX_ARWEAVE_GATEWAY;
    else process.env.ABX_ARWEAVE_GATEWAY = prevAr;
  }
});

test('resolveGatewayBase: no override, no env → the generic public default', () => {
  const prevIpfs = process.env.ABX_IPFS_GATEWAY;
  const prevAr = process.env.ABX_ARWEAVE_GATEWAY;
  delete process.env.ABX_IPFS_GATEWAY;
  delete process.env.ABX_ARWEAVE_GATEWAY;
  try {
    assert.equal(resolveGatewayBase('ipfs'), 'https://ipfs.io');
    assert.equal(resolveGatewayBase('arweave'), 'https://arweave.net');
    assert.equal(resolveGatewayBase('http'), ''); // http locators carry their own base
  } finally {
    if (prevIpfs === undefined) delete process.env.ABX_IPFS_GATEWAY;
    else process.env.ABX_IPFS_GATEWAY = prevIpfs;
    if (prevAr === undefined) delete process.env.ABX_ARWEAVE_GATEWAY;
    else process.env.ABX_ARWEAVE_GATEWAY = prevAr;
  }
});

// ── the three verdicts ────────────────────────────────────────────────────────

test('ready: the gateway that matters serves it', async () => {
  const {fn} = fakeFetch({'arweave.net': serving, 'permagate.io': serving, 'vilenarios.com': serving});
  const s = await locatorStatus(`ar://${TXID}`, {gateway: 'https://arweave.net', fetchFn: fn});
  assert.equal(s.readiness, 'ready');
  assert.equal(s.primary.bytes, 230596); // total from content-range, not the 1 byte a 206 returns
  assert.equal(s.primary.contentType, 'image/png');
});

test('propagating: another gateway serves it, so the data provably EXISTS — yours is behind', async () => {
  // This is the case both integrators actually hit: 32/32 404 on arweave.net while 22/32 already
  // served from permagate.io, with the uploader reporting CONFIRMED the whole time.
  const {fn} = fakeFetch({'arweave.net': missing, 'permagate.io': serving, 'vilenarios.com': missing});
  const s = await locatorStatus(`ar://${TXID}`, {gateway: 'https://arweave.net', fetchFn: fn});
  assert.equal(s.readiness, 'propagating');
  assert.equal(s.primary.serving, false);
  assert.deepEqual(s.alternates.filter((a) => a.serving).map((a) => a.gateway), ['permagate.io']);
});

test('unreachable when nothing serves it — deliberately NOT called propagating', async () => {
  // From outside, a locator that is still settling and one that is simply wrong look identical.
  // Reporting the friendlier of the two is how a tool teaches someone to ignore it.
  const {fn} = fakeFetch({'arweave.net': missing, 'permagate.io': missing, 'vilenarios.com': missing});
  const s = await locatorStatus(`ar://${TXID}`, {gateway: 'https://arweave.net', fetchFn: fn});
  assert.equal(s.readiness, 'unreachable');
});

test('a gateway that never answers is unreachable, with the reason kept', async () => {
  const {fn} = fakeFetch({'arweave.net': undefined, 'permagate.io': undefined, 'vilenarios.com': undefined});
  const s = await locatorStatus(`ar://${TXID}`, {gateway: 'https://arweave.net', timeoutMs: 50, fetchFn: fn});
  assert.equal(s.readiness, 'unreachable');
  assert.equal(s.primary.status, null);
  assert.match(s.primary.error!, /no response/);
});

// ── the probe's own contract ──────────────────────────────────────────────────

test('--primary-only asks exactly one gateway (and so can never report propagating)', async () => {
  const {fn, asked} = fakeFetch({'arweave.net': missing});
  const s = await locatorStatus(`ar://${TXID}`, {gateway: 'https://arweave.net', primaryOnly: true, fetchFn: fn});
  assert.equal(asked.length, 1);
  assert.deepEqual(s.alternates, []);
  assert.equal(s.readiness, 'unreachable');
});

test('an http locator has no alternates — a different host would answer about different bytes', async () => {
  const {fn, asked} = fakeFetch({'cdn.example.com': serving});
  const s = await locatorStatus('https://cdn.example.com/art.png', {fetchFn: fn});
  assert.equal(s.network, 'http');
  assert.equal(asked.length, 1);
  assert.equal(s.readiness, 'ready');
});

test('the primary is never also probed as an alternate', async () => {
  const {fn, asked} = fakeFetch({'permagate.io': serving, 'vilenarios.com': serving});
  await locatorStatus(`ar://${TXID}`, {gateway: 'https://permagate.io', fetchFn: fn});
  assert.equal(asked.filter((u) => u.includes('permagate.io')).length, 1);
});

test('a Range-ignoring gateway (200 + whole body) still reports size, and the body is released', async () => {
  let cancelled = false;
  const fn = (async () =>
    ({
      status: 200,
      headers: new Headers({'content-length': '4096', 'content-type': 'text/html'}),
      body: {cancel: async () => { cancelled = true; }},
    }) as unknown as Response) as unknown as typeof fetch;
  const p = await probeGateway('https://ipfs.io/ipfs/x', {fetchFn: fn});
  assert.equal(p.serving, true);
  assert.equal(p.bytes, 4096);
  // Without this, checking a 40 MB asset would download all 40 MB just to learn it exists.
  assert.equal(cancelled, true);
});

// ── awaitLocatorReady: the poll loop `locatorStatus` alone can't do ───────────

test('awaitLocatorReady: ready on the very first probe returns immediately, no polling', async () => {
  const {fn} = fakeFetch({'arweave.net': serving});
  const r = await awaitLocatorReady(`ar://${TXID}`, {gateway: 'https://arweave.net', primaryOnly: true, fetchFn: fn, pollBaseMs: 5});
  assert.equal(r.ready, true);
  assert.equal(r.attempts, 1);
  assert.equal(r.status.readiness, 'ready');
});

test('awaitLocatorReady: polls (linear backoff) until the gateway starts serving', async () => {
  // Not ready for the first two probes, ready on the third — the exact shape of "uploaded, then
  // caught up a few seconds later" this helper exists for.
  let calls = 0;
  const fn = (async () => {
    calls++;
    const answer = calls < 3 ? missing : serving;
    return {status: answer.status, headers: new Headers((answer as {headers?: Record<string, string>}).headers ?? {}), body: null} as unknown as Response;
  }) as unknown as typeof fetch;
  const events: Array<{attempt: number; elapsedMs: number}> = [];
  const r = await awaitLocatorReady(`ar://${TXID}`, {
    gateway: 'https://arweave.net',
    primaryOnly: true,
    fetchFn: fn,
    pollBaseMs: 5, // keep the test fast — the backoff SHAPE is what's under test, not real timing
    onEvent: (e) => events.push({attempt: e.attempt, elapsedMs: e.elapsedMs}),
  });
  assert.equal(r.ready, true);
  assert.equal(r.attempts, 3);
  assert.equal(calls, 3);
  // One event per attempt, in order — a caller (a CLI spinner) can narrate every poll, not just the last.
  assert.deepEqual(events.map((e) => e.attempt), [1, 2, 3]);
});

test('awaitLocatorReady: gives up at the deadline and reports the last (not-ready) status, never throws', async () => {
  const {fn} = fakeFetch({'arweave.net': missing});
  const r = await awaitLocatorReady(`ar://${TXID}`, {
    gateway: 'https://arweave.net',
    primaryOnly: true,
    fetchFn: fn,
    pollBaseMs: 5,
    timeoutMs: 12, // deliberately shorter than even a couple of backoff steps
  });
  assert.equal(r.ready, false);
  assert.equal(r.status.readiness, 'unreachable');
  assert.ok(r.attempts >= 1);
});
