import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CHAIN_SUPPORT} from '@artblocks/abx-sdk';
import {tokenViewerUrl, viewerSurface} from '../src/view-url.js';

const contract = `0x${'ab'.repeat(20)}`;
test('viewer URLs retain custom path prefixes across the shared supported-chain inventory', () => {
  for (const chain of CHAIN_SUPPORT) {
    assert.equal(tokenViewerUrl({baseUrl: 'https://example.com/resolver/'}, chain.chainId, contract, '00042', true), `https://example.com/resolver/a/${chain.chainId}/${contract}/42`);
    assert.equal(tokenViewerUrl({baseUrl: 'https://example.com/resolver'}, chain.chainId, contract, '42', false), `https://example.com/resolver/t/${chain.chainId}/${contract}/42/data/image`);
  }
});
test('discovered content templates use the SDK policy and unknown schemes fall back to the selected resolver', () => {
  const content = {liveViewUrlTemplate: 'https://{chainId}-{address}-{tokenId}.example.com/'};
  assert.equal(tokenViewerUrl({baseUrl: 'https://example.com/prefix', content}, 8453, contract, '7', true), `https://8453-${contract}-7.example.com/`);
  assert.equal(tokenViewerUrl({baseUrl: 'https://example.com/prefix', content: {...content, scheme: 'unknown'}}, 8453, contract, '7', true), `https://example.com/prefix/a/8453/${contract}/7`);
});
test('viewer input rejects route injection, non-uint256 IDs and credentialed bases', async () => {
  for (const id of ['-1', '../x', '1/2', String(1n << 256n)]) assert.throws(() => tokenViewerUrl({baseUrl: 'https://example.com'}, 1, contract, id, true));
  await assert.rejects(viewerSurface({'base-url': 'https://secret@example.com'}), /without credentials/);
  await assert.rejects(viewerSurface({'base-url': 'https://example.com', remote: 'abx'}), /choose/);
});
