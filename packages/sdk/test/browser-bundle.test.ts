// The permanent regression guard for the SDK's browser safety (see clients.ts/chains.ts's
// `readEnv`, and `node.ts`'s subpath split): bundle the package's main entry with esbuild under
// `platform: 'browser'` and assert it succeeds with no `node:*` resolution errors. Under
// `platform: 'browser'` esbuild does NOT polyfill Node builtins — a bare `import 'node:fs'`
// anywhere in the import graph fails the build with "Could not resolve", which is exactly the
// failure mode this test exists to catch.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_INDEX = resolve(HERE, '../src/index.ts');

test('the SDK entry bundles for the browser with no node:* resolution errors', async () => {
  const result = await build({
    stdin: {
      contents: `import * as sdk from ${JSON.stringify(SDK_INDEX)};\nexport {sdk};\n`,
      resolveDir: HERE,
      sourcefile: 'browser-bundle-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  });
  assert.equal(result.errors.length, 0, `esbuild reported errors:\n${JSON.stringify(result.errors, null, 2)}`);
});
