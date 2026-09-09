// `abx attach` used to warn only on an EMPTY resolver base and otherwise print a confident
// "listed in this project's resolver artifacts" — it never checked whether anything was actually
// SERVING, and it never returned a URL a human or agent could fetch without hand-assembling the
// route grammar from the docs.
//
// `canonicalAttachmentUrl`/`probeResolverReachable` are the two pure(ish) pieces this is built on
// (packages/cli/src/ownerops.ts) — both exported and chain/network-free to call directly, the same
// seam `served.ts`'s `fetchServedTokenUri` uses (its own tests inject a fake `fetch`, never a real
// server). That is what lets all THREE serving topologies be pinned here without a live signed tx:
//
//   - fully-on-chain   (no resolver base baked in at all) — the CLI-level test at the bottom, run
//     against a real, permanently fully-on-chain fixture with --dry-run (every read below happens
//     regardless of --dry-run, so the branch selection is exercised for real).
//   - local-resolver   (a base that happens to be localhost) — `probeResolverReachable` with an
//     injected fetch standing in for a locally-running `abx serve`.
//   - remote-resolver  (a base that happens to be a real host) — the same function, same shape,
//     against a hosted-looking base; the point of this design is that BOTH topologies run through
//     the identical code path (a marketplace only ever fetches the base baked on-chain — it does
//     not care whether that host happens to be a laptop or a Fly.io box).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import type {Address} from 'viem';
import {canonicalAttachmentUrl, probeResolverReachable} from '../src/ownerops.js';

const CONTRACT = '0x00000000000000000000000000000000c0ffee' as Address;

// ── canonicalAttachmentUrl: the route grammar, so nobody hand-assembles it ────

test('canonicalAttachmentUrl: token scope is {base}/{chainId}/{address}/{tokenId}/data/{key}', () => {
  const url = canonicalAttachmentUrl({uriBase: 'https://my-resolver.fly.dev/t', chainId: 84532, contract: CONTRACT, tokenId: 0n, key: 'stems'});
  assert.equal(url, `https://my-resolver.fly.dev/t/84532/${CONTRACT}/0/data/stems`);
});

test('canonicalAttachmentUrl: collection scope (no tokenId) is {base}/{chainId}/{address}/data/{key}', () => {
  const url = canonicalAttachmentUrl({uriBase: 'https://my-resolver.fly.dev/c', chainId: 84532, contract: CONTRACT, key: 'certificate'});
  assert.equal(url, `https://my-resolver.fly.dev/c/84532/${CONTRACT}/data/certificate`);
});

test('canonicalAttachmentUrl: a trailing slash on the baked base is not doubled', () => {
  const url = canonicalAttachmentUrl({uriBase: 'https://my-resolver.fly.dev/t/', chainId: 1, contract: CONTRACT, tokenId: 3n, key: 'k'});
  assert.equal(url, `https://my-resolver.fly.dev/t/1/${CONTRACT}/3/data/k`);
});

test('canonicalAttachmentUrl: a key with characters needing escape is encoded', () => {
  const url = canonicalAttachmentUrl({uriBase: 'https://host/t', chainId: 1, contract: CONTRACT, tokenId: 0n, key: 'a b/c'});
  assert.match(url, /data\/a%20b%2Fc$/);
});

// ── probeResolverReachable: the three serving topologies ──────────────────────

test('probeResolverReachable: LOCAL-RESOLVER topology — a healthy local `abx serve` reports reachable', async () => {
  const result = await probeResolverReachable({
    uriBase: 'http://localhost:8787/t',
    chainId: 84532,
    contract: CONTRACT,
    tokenId: 0n,
    fetchFn: (async () => new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})) as unknown as typeof fetch,
  });
  assert.equal(result.reachable, true);
  assert.equal(result.url, `http://localhost:8787/t/84532/${CONTRACT}/0`);
  assert.match(result.detail, /200/);
});

test('probeResolverReachable: LOCAL-RESOLVER topology — nothing listening (no `abx serve` running) reports unreachable with the transport error', async () => {
  const result = await probeResolverReachable({
    uriBase: 'http://localhost:8787/t',
    chainId: 84532,
    contract: CONTRACT,
    tokenId: 0n,
    fetchFn: (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8787');
    }) as unknown as typeof fetch,
  });
  assert.equal(result.reachable, false);
  assert.match(result.detail, /ECONNREFUSED/);
});

test('probeResolverReachable: REMOTE-RESOLVER topology — a hosted resolver that knows this project reports reachable', async () => {
  const result = await probeResolverReachable({
    uriBase: 'https://my-resolver.fly.dev/t',
    chainId: 84532,
    contract: CONTRACT,
    tokenId: 0n,
    fetchFn: (async () => new Response('{"name":"X"}', {status: 200})) as unknown as typeof fetch,
  });
  assert.equal(result.reachable, true);
  assert.equal(result.url, `https://my-resolver.fly.dev/t/84532/${CONTRACT}/0`);
});

test('probeResolverReachable: REMOTE-RESOLVER topology — a resolver that has never heard of this project (registered elsewhere) reports unreachable with its status', async () => {
  // The project may be perfectly served BY SOMEONE — just not by the base baked on-chain (a stale
  // re-point, or a resolver that never got `abx add`-ed). A 404 here is real, actionable signal.
  const result = await probeResolverReachable({
    uriBase: 'https://my-resolver.fly.dev/t',
    chainId: 84532,
    contract: CONTRACT,
    tokenId: 0n,
    fetchFn: (async () => new Response('{"error":"unknown_project"}', {status: 404})) as unknown as typeof fetch,
  });
  assert.equal(result.reachable, false);
  assert.match(result.detail, /404/);
});

test('probeResolverReachable: collection scope probes the collection document (no tokenId in the URL)', async () => {
  const result = await probeResolverReachable({
    uriBase: 'https://my-resolver.fly.dev/c',
    chainId: 84532,
    contract: CONTRACT,
    fetchFn: (async () => new Response('{}', {status: 200})) as unknown as typeof fetch,
  });
  assert.equal(result.url, `https://my-resolver.fly.dev/c/84532/${CONTRACT}`);
});

// ── the FULLY-ON-CHAIN topology, end to end against a real fixture ───────────
// `attach --dry-run` still reads chain for real (owner + the scope-correct uriBase getter) — only
// the SEND is skipped — so this exercises the actual branch selection, not just its wording.

const CLI_MAIN = resolve(import.meta.dirname, '../src/main.ts');
const noAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, '');
const BATCH_ADDR = '0xa9B8616396424A2dd54ceD71F27f51C3090Bf294'; // sepolia — empty tokenURIBase AND contractURIBase

function runCli(args: string[]): {code: number; out: string} {
  try {
    const out = execFileSync('node', ['--import', 'tsx', CLI_MAIN, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ABX_NO_UPDATE_CHECK: '1', ABX_CHAIN: 'sepolia'},
      timeout: 30_000,
    });
    return {code: 0, out: noAnsi(out)};
  } catch (e) {
    const err = e as {status?: number; stdout?: string; stderr?: string};
    return {code: err.status ?? 1, out: noAnsi((err.stdout ?? '') + (err.stderr ?? ''))};
  }
}

test('FULLY-ON-CHAIN topology (token scope): warns there is NO serving path, and prints no canonical fetch URL', () => {
  const {out} = runCli(['attach', BATCH_ADDR, 'stems', 'ipfs://QmA/stems.wav', '--dry-run']);
  assert.match(out, /resolves ON-CHAIN/);
  assert.match(out, /NO off-chain serving path at all/);
  assert.doesNotMatch(out, /→ fetch:/);
});

test('FULLY-ON-CHAIN topology (--collection scope): reads contractURIBase, not tokenURIBase, and warns the same way', () => {
  // This also covers a scope bug: --collection used to read tokenURIBase regardless. This proves
  // the collection-scope read path runs to completion (no crash, no wrong-getter revert) and lands
  // on the same honest "no serving path" warning contractURIBase being empty implies.
  const {code, out} = runCli(['attach', BATCH_ADDR, 'certificate', 'ipfs://QmB/coa.pdf', '--collection', '--dry-run']);
  assert.equal(code, 0, out);
  assert.match(out, /resolves ON-CHAIN/);
  assert.doesNotMatch(out, /→ fetch:/);
});
