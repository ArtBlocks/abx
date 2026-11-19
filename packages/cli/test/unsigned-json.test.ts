import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {ABX_CORE_VERSION, encodeTag, oneOfOneImageAbi, oneOfOneImageFactoryAbi} from '@artblocks/abx-sdk';
import {decodeFunctionData, encodeAbiParameters, toFunctionSelector, toHex, type Hex} from 'viem';

const run = promisify(execFile);
const main = resolve(import.meta.dirname, '../src/main.ts');
const signer = '0x0000000000000000000000000000000000000011';
const clone = '0x0000000000000000000000000000000000000022';

test('real CLI entry points prepare 1/1 deployment and field writes as one unsigned JSON document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abx-unsigned-json-'));
  const image = join(dir, 'sample.svg');
  await writeFile(image, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  const word = (value: bigint) => encodeAbiParameters([{type: 'uint256'}], [value]);
  const addressWord = (address: Hex) => encodeAbiParameters([{type: 'address'}], [address]);
  const calls = new Map<string, Hex>([
    [toFunctionSelector('owner()'), addressWord(signer)],
    [toFunctionSelector('implementation()'), addressWord(clone)],
    [toFunctionSelector('abxVersion()'), word(ABX_CORE_VERSION)],
    [toFunctionSelector('totalSupply()'), word(0n)],
    [toFunctionSelector('specVersion()'), word(12n)],
    [toFunctionSelector('predictDeterministicAddress(bytes32)'), addressWord(clone)],
  ]);
  const unexpected: string[] = [];
  const rpc = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const {id, method, params} = JSON.parse(body);
    const result = method === 'eth_chainId' ? '0xaa36a7'
      : method === 'eth_getBalance' ? '0x0'
      : method === 'eth_getCode' ? '0x01'
      : method === 'eth_call' ? calls.get(params[0].data.slice(0, 10))
      : undefined;
    if (result === undefined) unexpected.push(method);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({jsonrpc: '2.0', id, ...(result === undefined
      ? {error: {code: -32601, message: 'Unexpected RPC request'}}
      : {result})}));
  });
  await new Promise<void>((ready) => rpc.listen(0, '127.0.0.1', ready));
  try {
    const address = rpc.address();
    assert.ok(address && typeof address === 'object');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ABX_CHAIN: 'sepolia',
      ABX_DEPLOYER_PK: '',
      ABX_NO_UPDATE_CHECK: '1',
      ABX_DATA_DIR: dir,
      ABX_RPC_URLS_SEPOLIA: `http://127.0.0.1:${address.port}`,
    };
    delete env.ABX_PUBLIC_BASE_URL;
    const cli = (args: string[]) => run(process.execPath, ['--import', 'tsx', main, ...args, '--unsigned', '--json'], {env, timeout: 30_000});
    const deployment = await cli(['deploy', '--image', image, '--onchain-uri', '--for', signer, '--name', 'Unsigned test', '--symbol', 'TEST']);
    const deployPlan = JSON.parse(deployment.stdout);
    assert.equal(deployPlan.sent, false);
    assert.deepEqual(deployPlan.predicted, {clone});
    assert.equal(deployPlan.txs.length, 1);
    assert.equal(deployPlan.txs[0].chainId, 11155111);
    assert.equal(deployPlan.txs[0].expectedSigner, signer);
    assert.equal(decodeFunctionData({abi: oneOfOneImageFactoryAbi, data: deployPlan.txs[0].data}).functionName, 'deployDeterministic');
    assert.match(deployment.stderr, /Deploy "Unsigned test"/);

    const field = await cli(['set-field', clone, '--field', 'description', '--text', 'new text']);
    const fieldPlan = JSON.parse(field.stdout);
    assert.equal(fieldPlan.sent, false);
    assert.equal(fieldPlan.txs.length, 1);
    const [tx] = fieldPlan.txs;
    assert.equal(tx.to, clone);
    assert.equal(tx.expectedSigner, signer);
    assert.equal(decodeFunctionData({abi: oneOfOneImageAbi, data: tx.data}).functionName, 'setTokenField');
    assert.match(field.stderr, /Set on-chain description/);
    const animation = ['set-field', clone, '--field', 'animation_url'];
    const locator = 'https://example.org/site/index.html?preview=1';
    const link = await cli([...animation, '--url', locator]);
    const data = JSON.parse(link.stdout).txs[0].data;
    assert.deepEqual(
      decodeFunctionData({abi: oneOfOneImageAbi, data}).args,
      [0n, encodeTag('animation_url'), encodeTag('url'), toHex(locator)],
    );
    const legacyLink = await cli([...animation, '--text', locator, '--representation', 'url']);
    assert.equal(JSON.parse(legacyLink.stdout).txs[0].data, data);
    await assert.rejects(cli([...animation, '--text', locator]), /Use --url for a locator in animation_url/);
    await assert.rejects(cli([...animation, '--url', locator, '--text', '<p>example</p>']), /Pass --url on its own/);
    const inline = await cli([...animation, '--text', locator, '--representation', 'inline']);
    assert.equal(JSON.parse(inline.stdout).txs[0].fields.representation, 'inline');
    assert.deepEqual(unexpected, []);
  } finally {
    await new Promise<void>((done) => rpc.close(() => done()));
    await rm(dir, {recursive: true, force: true});
  }
});
