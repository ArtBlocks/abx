import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discoverDeployBlock} from '../src/reconstruct.ts';

// discoverDeployBlock is the scan floor for a fresh reconstruction: it finds a contract's deploy
// block with a getCode binary search (archive-depth, but NO eth_getLogs), so an `add` starts there
// instead of sweeping from genesis. It MUST fail safe — a too-high floor (from a pruned node) is
// worse than genesis (you'd silently miss the deploy event), so any anomaly returns null.

const ADDR = '0x00000000000000000000000000000000000000ab' as const;
const CODE = '0x60006000' as const;
const EMPTY = '0x' as const;

/** A fake client where `address` has code from `deployBlock` onward; head at `head`. */
function fakeClient(deployBlock: bigint, head: bigint, opts: {throwBelowHead?: boolean} = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    async getBlockNumber() {
      return head;
    },
    async getCode({blockNumber}: {address: string; blockNumber: bigint}) {
      calls++;
      if (opts.throwBelowHead && blockNumber < head) throw new Error('missing trie node (non-archive node)');
      return blockNumber >= deployBlock ? CODE : EMPTY;
    },
  };
}

test('discoverDeployBlock binary-searches to the EXACT deploy block, in log-scale calls', async () => {
  const client = fakeClient(11_238_537n, 11_300_000n);
  const found = await discoverDeployBlock(client as never, ADDR);
  assert.equal(found, 11_238_537n);
  // ~log2(span) getCode calls (+ the head check) — proof it's not a linear from-genesis scan.
  assert.ok(client.calls() < 40, `expected a log-scale search, got ${client.calls()} getCode calls`);
});

test('discoverDeployBlock returns null when the address has no code at head (never deployed / wrong chain)', async () => {
  const noCode = {
    async getBlockNumber() {
      return 100n;
    },
    async getCode() {
      return EMPTY;
    },
  };
  assert.equal(await discoverDeployBlock(noCode as never, ADDR), null);
});

test('discoverDeployBlock fails SAFE (null) when historical getCode is unavailable (non-archive RPC)', async () => {
  // Code IS present at head, but any historical read throws — must NOT guess a too-high floor.
  const client = fakeClient(50n, 100n, {throwBelowHead: true});
  assert.equal(await discoverDeployBlock(client as never, ADDR), null);
});

test('discoverDeployBlock honors an explicit toBlock ceiling (no getBlockNumber call needed)', async () => {
  const client = {
    async getBlockNumber(): Promise<bigint> {
      throw new Error('should not be called when toBlock is given');
    },
    async getCode({blockNumber}: {address: string; blockNumber: bigint}) {
      return blockNumber >= 42n ? CODE : EMPTY;
    },
  };
  assert.equal(await discoverDeployBlock(client as never, ADDR, 1000n), 42n);
});
