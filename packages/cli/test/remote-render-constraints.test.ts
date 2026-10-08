import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');

test('abx remote reports an advertised managed-renderer no-GPU constraint', async () => {
  const server = createServer((req, res) => {
    if (req.url !== '/.well-known/abx-service') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({
      service: {name: 'Managed Test'},
      interfaces: ['abx-token-api/v1'],
      chains: [11155111],
      render: {
        attached: true,
        constraints: {hardwareAcceleration: false, maxCaptureDelayMs: 45_000},
        effects: [{key: 'render', outputs: [{key: 'image', mimeType: 'image/png'}]}],
      },
    }));
  });
  await new Promise<void>((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const out = await new Promise<string>((resolveRun) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', MAIN, 'remote', `http://127.0.0.1:${address.port}`],
        {env: {...process.env, ABX_CHAIN: 'sepolia', ABX_REMOTE_SELF_TOKEN: '', ABX_PUBLIC_BASE_URL: ''}, timeout: 60_000},
        (_err, stdout, stderr) => resolveRun(`${stdout}\n${stderr}`),
      );
    });
    assert.match(out, /CPU\/headless/i);
    assert.match(out, /render\.captureDelay up to 45000ms/i);
    assert.match(out, /GPU-capable effects worker/i);
  } finally {
    server.close();
  }
});
