import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {seriesCodeAbi, seriesCodeFactoryAbi} from '@artblocks/abx-sdk';
import {decodeFunctionData, encodeAbiParameters, parseAbi, parseTransaction, toFunctionSelector, type Hex} from 'viem';

const run = promisify(execFile);
const main = resolve(import.meta.dirname, '../src/main.ts');
const signer = '0x0000000000000000000000000000000000000011';
const clone = '0x0000000000000000000000000000000000000022';
const oracleAbi = parseAbi(['function getL1Fee(bytes) view returns (uint256)']);
const word = (value: bigint) => encodeAbiParameters([{type: 'uint256'}], [value]);

for (const [chain, chainId] of [['base', 8453], ['base-sepolia', 84532]] as const) {
  test(`${chain} dry-run quotes each prepared transaction and preserves an unavailable fee`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'abx-deploy-base-fees-'));
    const script = join(dir, 'sketch.js');
    await writeFile(script, 'document.body.textContent = "An ABX fee estimate fixture";');
    const l1Requests: Hex[] = [];
    const methods: string[] = [];
    let failL1 = false;
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const {id, method, params} = JSON.parse(body);
      methods.push(method);
      let result: Hex | undefined;
      if (method === 'eth_chainId') result = `0x${chainId.toString(16)}`;
      if (method === 'eth_getCode') result = '0x01';
      if (method === 'eth_getBalance') result = '0x0';
      if (method === 'eth_gasPrice') result = '0x2';
      if (method === 'eth_estimateGas') result = '0x493e0'; // 300,000
      if (method === 'eth_call') {
        const calldata = (params[0].data ?? params[0].input ?? '0x') as Hex;
        const selector = calldata.slice(0, 10);
        if (selector === toFunctionSelector('predictDeterministicAddress(bytes32)')) {
          result = encodeAbiParameters([{type: 'address'}], [clone]);
        }
        if (selector === toFunctionSelector('getOperatorFee(uint256)')) result = word(7n);
        if (selector === toFunctionSelector('getL1Fee(bytes)')) {
          l1Requests.push(decodeFunctionData({abi: oracleAbi, data: calldata}).args[0]);
          if (!failL1) result = word(BigInt(l1Requests.length) * 100n);
        }
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({jsonrpc: '2.0', id, ...(result === undefined
        ? {error: {code: -32601, message: 'Unavailable'}}
        : {result})}));
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    t.after(async () => {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(dir, {recursive: true, force: true});
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const env = {
      ...process.env,
      ABX_CHAIN: chain, ABX_DEPLOYER_PK: '', ABX_NO_UPDATE_CHECK: '1', ABX_DATA_DIR: dir,
      [chain === 'base' ? 'ABX_RPC_URLS_BASE' : 'ABX_RPC_URLS_BASE_SEPOLIA']: `http://127.0.0.1:${address.port}`,
    };
    const preview = async (args: string[], lane = '--unsigned') => {
      const {stdout, stderr} = await run(process.execPath, ['--import', 'tsx', main, ...args,
        '--for', signer, '--name', 'Fee test', '--symbol', 'FEE', '--public-base-url', 'https://example.test',
        lane, '--dry-run', '--json'], {env, timeout: 30_000});
      const output = JSON.parse(stdout);
      assert.equal(output.sent, false);
      return {estimate: output.plan.estimate, stderr};
    };
    const {estimate} = await preview(['deploy-code', '--script', script, '--no-mint']);
    const [deploy, setup] = l1Requests.map((input) => parseTransaction(input as `0x02${string}`));
    assert.equal(l1Requests.length, 2);
    assert.equal(deploy.chainId, chainId);
    assert.equal(decodeFunctionData({abi: seriesCodeFactoryAbi, data: deploy.data!}).functionName, 'deployDeterministic');
    assert.equal(setup.to, clone);
    assert.equal(decodeFunctionData({abi: seriesCodeAbi, data: setup.data!}).functionName, 'multicall');
    const fees = estimate.feeBreakdown;
    assert.equal(fees.executionGasSource, 'heuristic'); // the setup transaction runs only after deployment
    assert.equal(fees.executionFeeWei, (BigInt(estimate.gasApprox) * 2n).toString());
    assert.equal(fees.l1DataFeeWei, '300');
    assert.equal(fees.operatorFeeWei, '14');
    assert.equal(fees.totalWei, (BigInt(fees.executionFeeWei) + 314n).toString());

    failL1 = true;
    const partial = await preview(['deploy']);
    assert.equal(partial.estimate.feeBreakdown.executionGasSource, 'rpc');
    assert.equal(partial.estimate.feeBreakdown.executionFeeWei, '600000');
    assert.equal(partial.estimate.feeBreakdown.operatorFeeWei, '7');
    assert.equal(partial.estimate.feeBreakdown.l1DataFeeWei, null);
    assert.equal(partial.estimate.feeBreakdown.totalWei, null);
    assert.match(partial.stderr, /L1 data fee: unavailable/);

    const image = join(dir, 'image.svg');
    await writeFile(image, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    const quotesBeforeStaging = l1Requests.length;
    const staged = await preview(['deploy', '--image', image, '--onchain-image'], '--sign');
    assert.match(staged.estimate.feeBreakdown.unavailableReason, /staging transaction/);
    assert.equal(staged.estimate.feeBreakdown.totalWei, null);
    assert.equal(l1Requests.length, quotesBeforeStaging);
    assert.equal(methods.filter((method) => method === 'eth_estimateGas').length, 2);
    assert.ok(methods.every((method) => !method.startsWith('eth_send')));
  });
}
