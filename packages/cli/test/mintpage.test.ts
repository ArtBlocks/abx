import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mintPageArtifact, PUBLIC_RPC, type MintPageOptions} from '../src/mintpage.js';

const OPTS: MintPageOptions = {
  token: '0x60831172a3927ed7b2c3AD7fabf159a73fC2Df5a',
  minter: '0x9ACc867c14DeeB8A47e2F040a7A113a66407138A',
  chainId: 11155111,
  chainName: 'Sepolia',
  rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  collectionName: 'Minter Smoke 2',
  explorer: 'https://sepolia.etherscan.io',
};

function fileMap(o = OPTS): Record<string, string> {
  return Object.fromEntries(mintPageArtifact(o).files.map((f) => [f.path, f.content]));
}

test('mintPageArtifact: emits a complete, runnable Next.js app', () => {
  const files = fileMap();
  for (const p of [
    'package.json',
    'next.config.mjs',
    'tsconfig.json',
    '.env.local',
    'lib/config.ts',
    'lib/chain.ts',
    'lib/abi.ts',
    'lib/meta.ts',
    'app/layout.tsx',
    'app/page.tsx',
    'app/mint-client.tsx',
    'README.md',
  ]) {
    assert.ok(files[p], `missing ${p}`);
  }
  assert.match(files['package.json'], /"next":/);
  assert.match(files['package.json'], /"viem":/);
});

test('mintPageArtifact: bakes token/minter/chain/name into .env.local, not into source', () => {
  const files = fileMap();
  const env = files['.env.local'];
  assert.match(env, /NEXT_PUBLIC_TOKEN=0x60831172a3927ed7b2c3AD7fabf159a73fC2Df5a/);
  assert.match(env, /NEXT_PUBLIC_MINTER=0x9ACc867c14DeeB8A47e2F040a7A113a66407138A/);
  assert.match(env, /NEXT_PUBLIC_CHAIN_ID=11155111/);
  assert.match(env, /NEXT_PUBLIC_COLLECTION_NAME=Minter Smoke 2/);
  // source reads config from env — the address must NOT be hard-coded into a component
  assert.doesNotMatch(files['app/mint-client.tsx'], /0x60831172a3927ed7b2c3AD7fabf159a73fC2Df5a/);
  assert.match(files['lib/config.ts'], /process\.env\.NEXT_PUBLIC_TOKEN/);
});

test('mintPageArtifact: the example env never leaks a secret-keyed RPC (public endpoint only)', () => {
  const env = fileMap()['.env.example'];
  // the RPC is the shared public endpoint — no api-key path segment
  assert.match(env, /NEXT_PUBLIC_RPC_URL=https:\/\/ethereum-sepolia-rpc\.publicnode\.com/);
});

test('mintPageArtifact: mint path targets the minter purchase() with the ETH value', () => {
  const client = fileMap()['app/mint-client.tsx'];
  assert.match(client, /functionName: 'purchase'/);
  assert.match(client, /value: sale\.price/);
  // reads sale state via the SDK's shared readSaleConfig (not a hand-rolled 'sales' readContract),
  // and supply/paused straight off the token
  assert.match(client, /readSaleConfig\(publicClient, MINTER, TOKEN\)/);
  assert.match(client, /functionName: 'totalSupply'/);
});

test('mintPageArtifact: the mint button bounds the purchase to the terms the page displays', () => {
  const client = fileMap()['app/mint-client.tsx'];
  // the buyer's terms guard — an owner who re-configures mid-click gets SaleTermsChanged, not the
  // buyer's allowance. Both guard args come off the `sale` the page read and is showing.
  assert.match(client, /args: \[TOKEN, sale\.paymentToken, sale\.price\]/);
  assert.match(client, /SaleTermsChanged/); // and the revert is explained, not dumped raw
});

test('mintPageArtifact (edition): the purchase bounds the TOTAL (price × quantity) and the token id', () => {
  const client = fileMap({...OPTS, isEdition: true})['app/mint-client.tsx'];
  assert.match(client, /args: \[TOKEN, BigInt\(tokenId\), BigInt\(quantity\), sale\.paymentToken, value\]/);
  // `value` is price × quantity, so the bound and the attached ETH are the same number
  assert.match(client, /const value = sale\.price \* BigInt\(quantity\)/);
  assert.match(client, /SaleTermsChanged/);
});

test('mintPageArtifact: the sdk supplies the minter + token ABIs (no hand-typed fragments)', () => {
  const abi = fileMap()['lib/abi.ts'];
  assert.match(abi, /from '@artblocks\/abx-sdk\/abi'/);
  assert.match(abi, /abxFixedPriceMinterAbi/);
  assert.match(abi, /export const minterAbi = abxFixedPriceMinterAbi/);
  assert.doesNotMatch(abi, /name: 'sales'/, 'the sales fragment is no longer hand-typed here');
});

test('mintPageArtifact: the read client is the SDK\'s browser-safe makePublicClient, with an explicit rpcUrls list (never env resolution)', () => {
  const meta = fileMap()['lib/meta.ts'];
  assert.match(meta, /from '@artblocks\/abx-sdk'/);
  assert.match(meta, /makePublicClient\(\{rpcUrls:/);
  assert.doesNotMatch(meta, /createPublicClient/, 'no more raw viem client construction');
});

test('mintPageArtifact: package.json pins @artblocks/abx-sdk to the RESOLVED sdk version (not the CLI\'s — alpha counters diverge per package), caret-ranged', () => {
  const pkg = JSON.parse(fileMap()['package.json']);
  const pin = pkg.dependencies['@artblocks/abx-sdk'] as string;
  assert.match(pin, /^\^\d+\.\d+\.\d+/);
  const sdkVersion = JSON.parse(
    readFileSync(resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'sdk', 'package.json'), 'utf8'),
  ).version as string;
  assert.equal(pin, `^${sdkVersion}`);
});

test('mintPageArtifact: lib/meta.ts reads gateway + data: URI parsing from the sdk (no hand-rolled body)', () => {
  const meta = fileMap()['lib/meta.ts'];
  assert.match(meta, /from '@artblocks\/abx-sdk'/);
  assert.match(meta, /\bgatewayUrlFor\b/);
  assert.match(meta, /\bresolveGatewayBase\b/);
  assert.match(meta, /\bparseDataUri\b/);
  // the old hand-rolled bodies this replaces — must be gone, not just supplemented
  assert.doesNotMatch(meta, /ipfs\.io\/ipfs\/['"]? *\+/, 'toGateway must no longer hand-slice an ipfs:// locator');
  assert.doesNotMatch(meta, /uri\.indexOf\(','\)/, 'fetchJson must no longer hand-parse a data: URI\'s comma split');
});

test('PUBLIC_RPC: known chains have a keyless endpoint — INCLUDING the default chain', () => {
  assert.ok(PUBLIC_RPC[84532], 'base-sepolia is the toolkit default; its mint page must scaffold without --rpc');
  assert.ok(PUBLIC_RPC[8453]);
  assert.ok(PUBLIC_RPC[11155111]);
  assert.ok(PUBLIC_RPC[1]);
  assert.doesNotMatch(PUBLIC_RPC[11155111], /apiKey|infura|alchemy/i);
});
