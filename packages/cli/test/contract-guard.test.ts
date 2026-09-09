import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type {Address} from 'viem';
import {assertContractExists} from '../src/ownerops.js';

// Regression: an owner-op (attach/transfer/set-royalty/…) against an address with NO contract —
// previewing before deploy, a typo, or the wrong chain — used to leak viem's opaque
// `returned no data ("0x")`. Every owner-op reads the owner via the shared `read()` first, which now
// calls `assertContractExists` on failure to give an actionable message. These lock that in.

const DEAD = '0x000000000000000000000000000000000000dEaD' as Address;

/** A JSON-RPC stub answering eth_getCode with a fixed result. */
function stubRpc(code: string): Promise<{url: string; close: () => Promise<void>}> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        const one = (r: {id?: unknown; method?: string}) => ({
          jsonrpc: '2.0',
          id: r.id ?? 1,
          // eth_chainId defensively (base-sepolia 84532 / sepolia 11155111 both fine — the client
          // knows its chain statically); everything else → the code result.
          result: r.method === 'eth_chainId' ? '0x14a34' : code,
        });
        const payload = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address() as {port: number};
      resolve({url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r()))});
    });
  });
}

/** Point every chain's RPC at `url` for the duration of `fn` (the active ABX_CHAIN is unknown here). */
async function withStubRpc(url: string, fn: () => Promise<void>): Promise<void> {
  const keys = ['ABX_RPC_URLS', 'ABX_RPC_URLS_BASE_SEPOLIA', 'ABX_RPC_URLS_SEPOLIA'];
  const prev = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) process.env[k] = url;
  try {
    await fn();
  } finally {
    for (const [k, v] of prev) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test('assertContractExists: a codeless address throws the actionable "no contract" message', async () => {
  const stub = await stubRpc('0x'); // eth_getCode → 0x (no code)
  try {
    await withStubRpc(stub.url, async () => {
      await assert.rejects(() => assertContractExists(DEAD), /no contract at 0x[0-9a-fA-F]+ on .+ — nothing to operate on/);
    });
  } finally {
    await stub.close();
  }
});

test('assertContractExists: an address WITH code does not throw', async () => {
  const stub = await stubRpc('0x6080604052'); // eth_getCode → bytecode
  try {
    await withStubRpc(stub.url, async () => {
      await assert.doesNotReject(() => assertContractExists(DEAD));
    });
  } finally {
    await stub.close();
  }
});

test('assertContractExists: an unreachable RPC is a no-op (lets the caller’s original error surface)', async () => {
  await withStubRpc('http://127.0.0.1:1', async () => {
    await assert.doesNotReject(() => assertContractExists(DEAD));
  });
});
