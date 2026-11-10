import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {encodeTag, METADATA_FIELD as F, METADATA_REPRESENTATION as R} from '@artblocks/abx-sdk';
import {toHex, encodeAbiParameters} from 'viem';
import {authorshipContractFields} from '../src/ownerops.js';
import {loadCollectionMetadata, validateCollectionMetadata} from '../src/collection-metadata.js';

test('collection artwork flags do not replace the image field inherited by token art', () => {
  assert.deepEqual(authorshipContractFields({'banner-image': 'https://example.com/banner.png', 'featured-image': 'ipfs://featured'}), [
    {field: encodeTag(F.bannerImage), representation: encodeTag(R.url), value: toHex('https://example.com/banner.png')},
    {field: encodeTag(F.featuredImage), representation: encodeTag(R.url), value: toHex('ipfs://featured')}
  ]);
  assert.throws(() => authorshipContractFields({'banner-image': 'true'}), /needs an image URI/);
});

test('marketplace validation names missing and malformed fields without assuming provider ingestion', () => {
  const document = {name: 'Work', description: 'Description', image: 'data:image/png;base64,AAAA', external_link: 'https://example.com', banner_image: 'ipfs://banner', featured_image: 'ar://featured'};
  assert.equal(validateCollectionMetadata(document).valid, true);
  assert.deepEqual(validateCollectionMetadata(null).invalid, ['document']);
  assert.deepEqual(validateCollectionMetadata({...document, external_link: 'https://'}).invalid, ['external_link']);
  assert.deepEqual(validateCollectionMetadata({...document, image: '', banner_image: 42}), {
    profile: 'marketplace', valid: false, missing: ['image'], invalid: ['banner_image']
  });
});

test('handoff metadata inspection reads one bounded document and rejects oversized or non-object content', async () => {
  const uri = 'data:application/json;base64,' + Buffer.from('{"name":"Work"}').toString('base64');
  assert.deepEqual(await loadCollectionMetadata(uri), {name: 'Work'});
  let calls = 0;
  const fake: typeof fetch = async () => {calls++; return new Response(JSON.stringify({name: 'Work'}));};
  assert.deepEqual(await loadCollectionMetadata('https://example.com/metadata', fake), {name: 'Work'});
  assert.equal(calls, 1);
  await assert.rejects(loadCollectionMetadata('https://example.com/metadata', async () => new Response('x'.repeat(1024 * 1024 + 1))), /read budget/);
  await assert.rejects(loadCollectionMetadata('data:application/json;base64,W10='), /JSON object/);
});

test('CLI validation reads one document and refuses unresolved or non-JSON metadata', async () => {
  let uri = '';
  let documents = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += String(chunk);
      const request = JSON.parse(body);
      res.end(JSON.stringify({jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0xaa36a7' : encodeAbiParameters([{type: 'string'}], [uri])}));
    } else {
      documents++;
      res.end(req.url === '/bad' ? 'not JSON' : JSON.stringify({name: 'Work', description: 'Description', image: 'https://example.com/image.png', external_link: 'https://example.com', banner_image: 'https://example.com/banner.png', featured_image: 'https://example.com/featured.png'}));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/bin.ts', import.meta.url)), 'contracturi', `0x${'01'.repeat(20)}`, '--validate', 'marketplace', '--json'], {
    env: {...process.env, ABX_CHAIN: 'sepolia', ABX_RPC_URLS: `${base}/rpc`, ABX_RPC_URLS_SEPOLIA: `${base}/rpc`, ABX_SERVICES_API_KEY: '', ABX_NO_UPDATE_CHECK: '1', NO_COLOR: '1'}, timeout: 20_000
  });
  try {
    uri = `${base}/metadata`;
    const result = await run();
    assert.equal(JSON.parse(result.stdout).validation.valid, true);
    assert.equal(documents, 1);
    uri = 'ipfs://needs-an-explicit-gateway';
    await assert.rejects(run(), /explicit HTTP\(S\) gateway/);
    uri = `${base}/bad`;
    await assert.rejects(run(), /JSON/);
    assert.equal(documents, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
