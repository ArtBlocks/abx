import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {assertChainId} from '../src/clients.js';

// Regression: a `--dry-run` deploy still READS the chain (predict address, resolve the
// factory/renderer), so a wrong-network RPC used to fail deep inside viem as an opaque
// `predictDeterministicAddress returned no data ("0x")`. The deploy commands now call
// `assertChainId(CHAIN, {allowUnreachable: dryRun})` up front, which must (a) hard-fail a
// reachable-but-WRONG-network endpoint with the clear message even in preview, yet (b)
// tolerate a genuinely unreachable RPC so an offline dry-run can still preview.
//
// All cases use `base-sepolia` (expected id 84532) and never succeed, so the module-level
// success memo is never populated — no cross-case interference.

const KEY = 'base-sepolia';
const ENV = 'ABX_RPC_URLS_BASE_SEPOLIA';

/** A minimal JSON-RPC stub that answers `eth_chainId` with a fixed hex id. */
function stubRpc(chainIdHex: string): Promise<{url: string; close: () => Promise<void>}> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        const one = (r: {id?: unknown}) => ({jsonrpc: '2.0', id: r.id ?? 1, result: chainIdHex});
        const payload = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address() as {port: number};
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test('assertChainId: a reachable but WRONG-network RPC throws the clear mismatch even with allowUnreachable (the dry-run bug)', async () => {
  const stub = await stubRpc('0x1'); // reports mainnet (1), but base-sepolia expects 84532
  const before = process.env[ENV];
  process.env[ENV] = stub.url;
  try {
    await assert.rejects(
      () => assertChainId(KEY, {allowUnreachable: true}),
      /RPC network mismatch: the configured endpoint reports chain 1, but ABX_CHAIN='base-sepolia' expects 84532/,
    );
  } finally {
    if (before === undefined) delete process.env[ENV];
    else process.env[ENV] = before;
    await stub.close();
  }
});

test('assertChainId: an UNREACHABLE RPC is tolerated with allowUnreachable (offline dry-run still previews) but throws without it', async () => {
  const before = process.env[ENV];
  process.env[ENV] = 'http://127.0.0.1:1'; // nothing listens → connection refused
  try {
    // dry-run lane: swallow the unreachable RPC so an offline preview can proceed
    await assert.doesNotReject(() => assertChainId(KEY, {allowUnreachable: true}));
    // write lane: an unreachable RPC before an irreversible tx must hard-fail with guidance
    await assert.rejects(
      () => assertChainId(KEY),
      /Could not reach an RPC for 'base-sepolia' to verify the network/,
    );
  } finally {
    if (before === undefined) delete process.env[ENV];
    else process.env[ENV] = before;
  }
});
