import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
import {renderEffect} from '../src/render.js';
import type {EffectContext} from '../src/harness.js';

const available = existsSync(chromium.executablePath());

test('reference rendering refuses script errors before and after completion while retaining healthy fallback capture', {skip: !available}, async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    const script = req.url === '/error' ? 'window.abx={__traits:{a:1}};throw new Error("sensitive render detail")'
      : req.url === '/done-error' ? 'window.abx={__done:true,__traits:{a:1}};throw new Error("sensitive render detail")'
      : req.url === '/done' ? 'window.abx={__done:true,__traits:{a:1}}'
      : 'window.abx={__traits:{a:1}};console.error("optional diagnostic")';
    res.end(`<html><body>art<script>${script}</script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const effect = renderEffect({width: 100, timeoutMs: 100});
  const context = (path: string) => ({state: {}, liveViewUrl: `${origin}${path}`} as EffectContext);
  try {
    for (const path of ['/error', '/done-error']) {
      await assert.rejects(effect.run(context(path)), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /uncaught script error/);
        assert.equal(error.message.includes('sensitive render detail'), false);
        return true;
      });
    }
    for (const path of ['/done', '/fallback']) {
      const output = await effect.run(context(path));
      assert.ok(output.image?.bytes.length);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(output.traits?.bytes)), {a: 1});
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
