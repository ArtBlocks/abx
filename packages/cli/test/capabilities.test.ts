import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {ABX_CAPABILITIES} from '../src/capabilities.js';
import {DEPLOY_CODE_EDITION_FLAGS, DEPLOY_SERIES_EDITION_FLAGS} from '../src/commands/deploy.js';

const CLI = resolve(import.meta.dirname, '../src/main.ts');

function run(args: string[]): string {
  return execFileSync('node', ['--import', 'tsx', CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
  });
}

test('capabilities --json emits the typed capability contract exactly', () => {
  assert.deepEqual(JSON.parse(run(['capabilities', '--json'])), ABX_CAPABILITIES);
});

test('EditionCode supported capability flags reach its exhaustive allowlist', () => {
  for (const documented of ABX_CAPABILITIES.deploymentCommands.deployCode.edition.supported) {
    const flag = documented.split(/[\s(]/)[0].replace(/^--/, '');
    assert.ok(DEPLOY_CODE_EDITION_FLAGS.has(flag), `EditionCode capability says --${flag} works but its allowlist rejects it`);
  }
});

test('static editions expose on-chain image staging in code and help', () => {
  assert.ok(DEPLOY_SERIES_EDITION_FLAGS.has('onchain-image'));
  const help = run(['help', 'deploy-series']);
  assert.match(help, /--onchain-image/);
  assert.doesNotMatch(help, /--onchain-image is refused/);
});

test('summary help lists set-param-hooks — the only command that wires a custom hook', () => {
  const help = run(['help']);
  assert.match(help, /abx set-param-hooks/);
});

test('summary help does not regress EditionCode to script-only', () => {
  const help = run(['help']);
  // --code-dir and --image-base ship for EditionCode, so the summary names both. This replaces the
  // earlier script-only wording that the test used to pin.
  assert.match(help, /supports scripts, directory builds, dependencies, deterministic per-id off-chain stills, and Solidity image\/trait renderers/);
  assert.doesNotMatch(help, /--script only, no --code-dir\/--image-renderer/);
});

test('help exposes chain selection and agrees that param hooks support both code kinds', () => {
  assert.match(run(['help']), /ABX_CHAIN=<chain>.*there is no --chain flag/);
  const hooks = run(['help', 'set-param-hooks']);
  assert.match(hooks, /SeriesCode\/EditionCode only/);
  assert.doesNotMatch(hooks, /SeriesCode only/);
});

// `abx help scaffold solidity` used to answer `No help topic "scaffold"`.
//
// Found by a cold-agent sweep, and the reason it matters is that the CLI ITSELF recommends the
// nested form: `scaffold-renderer`'s entry calls itself a "compatibility alias for `abx scaffold
// solidity`; new automation should use the nested command". A tool that points you at a form it
// cannot then explain is how an agent concludes a command does not exist. `printCommandHelp` now
// tries the two-word topic and falls back to the bare command, mirroring `allowlistFor`.
test('help resolves a NESTED command topic, both as `help <cmd> <sub>` and `<cmd> <sub> --help`', () => {
  for (const args of [
    ['help', 'scaffold', 'solidity'],
    ['scaffold', 'solidity', '--help'],
  ]) {
    const out = run(args);
    assert.match(out, /abx scaffold solidity/, `${args.join(' ')} should print the nested topic`);
    assert.doesNotMatch(out, /No help topic/, `${args.join(' ')} must not report a missing topic`);
  }
});

// The other half of the same fix: the EditionCode code lane really does accept --code-dir and
// --image-base now (both verified with real on-chain deploys), and help must not still call them
// refused. The skill tells agents to trust --help OVER prose, so a stale refusal here is worse than
// a stale doc — it is the surface they were told to believe.
test('deploy-code help does not claim --code-dir / --image-base are refused on the edition lane', () => {
  const help = run(['help', 'deploy-code']);
  assert.doesNotMatch(help, /refused in code[^]*?--code-dir/, 'help still lists --code-dir as refused');
  assert.doesNotMatch(help, /--image-base \(needs the/, 'help still lists --image-base as refused');
  assert.match(help, /--code-dir[^]*?--image-base[^]*?WORK here too|WORK here too/, 'help should say both work on the edition lane');
});
