import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer, type Server} from 'node:http';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeAbiParameters} from 'viem';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const ADDRESS = '0xb5D472600107a56c0A36838FFf7030A864439a30';
const DOCUMENT = {name: 'Dust and daylight', description: 'Collection metadata', image: 'ipfs://bafy/image.svg'};

function mockRpc(contractUri: (port: number) => string): Promise<{server: Server; port: number}> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/collection.json') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify(DOCUMENT));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const call = JSON.parse(raw) as {id: number; method: string};
      let result: unknown;
      if (call.method === 'eth_chainId') result = '0xaa36a7';
      else if (call.method === 'eth_call') {
        const port = (server.address() as {port: number}).port;
        result = encodeAbiParameters([{type: 'string'}], [contractUri(port)]);
      } else if (call.method === 'eth_getCode') result = '0x6000';
      else result = null;
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({jsonrpc: '2.0', id: call.id, result}));
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({server, port: (server.address() as {port: number}).port})));
}

function run(port: number): Promise<{code: number; stdout: string; stderr: string}> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ABX_CHAIN: 'sepolia',
    ABX_RPC_URLS_SEPOLIA: `http://127.0.0.1:${port}`,
    ABX_NO_UPDATE_CHECK: '1',
  };
  delete env.ABX_RPC_URLS;
  return new Promise((done) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, 'contracturi', ADDRESS, '--json'], {env, timeout: 15_000}, (err, stdout, stderr) => {
      const code = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
      done({code, stdout, stderr});
    });
  });
}

test('contracturi --json emits an on-chain collection document as its only stdout payload', async () => {
  const dataUri = `data:application/json;base64,${Buffer.from(JSON.stringify(DOCUMENT)).toString('base64')}`;
  const {server, port} = await mockRpc(() => dataUri);
  try {
    const result = await run(port);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), DOCUMENT);
    assert.doesNotMatch(result.stdout, /contractURI|resolution|\u001b/);
  } finally {
    server.close();
  }
});

test('contracturi --json follows an HTTP URI and emits the fetched collection document only', async () => {
  const {server, port} = await mockRpc((actualPort) => `http://127.0.0.1:${actualPort}/collection.json`);
  try {
    const result = await run(port);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), DOCUMENT);
    assert.doesNotMatch(result.stdout, /contractURI|resolution|\u001b/);
  } finally {
    server.close();
  }
});
