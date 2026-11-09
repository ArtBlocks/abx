/**
 * `abx preview --check` against a real Chromium. Gated: the browser is an opt-in devDependency, so a
 * machine without Playwright + a Chromium build skips rather than fails.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const CLI = resolve(import.meta.dirname, '../src/main.ts');
const FIXTURES = resolve(import.meta.dirname, '../../../fixtures/determinism');

async function chromiumAvailable(): Promise<boolean> {
  try {
    const {chromium} = await import('playwright');
    const {existsSync} = await import('node:fs');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

async function webglAvailable(): Promise<boolean> {
  try {
    const {chromium} = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      return await page.evaluate(() => !!document.createElement('canvas').getContext('webgl'));
    } finally {
      await browser.close();
    }
  } catch {
    return false;
  }
}

const available = await chromiumAvailable();
if (process.env.ABX_PREVIEW_BROWSER_TESTS === '1' && !available) throw new Error('Pinned Chromium is required for the preview browser gate.');
const webgl = available && (await webglAvailable());

function check(script: string, frames = 1, extra: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', CLI, 'preview', '--script', resolve(FIXTURES, script), '--check', '--runs', '2', '--count', '2', '--json', ...(frames > 1 ? ['--frames', String(frames)] : []), ...extra],
    {encoding: 'utf8', timeout: 90_000, env},
  );
  assert.ifError(r.error);
  assert.ok(r.stdout.trim(), r.stderr);
  return {status: r.status, report: JSON.parse(r.stdout) as {ok: boolean; verdict: string; frames: number; seeds: Array<{hazards: string[]; driftFrames: number[]; done: boolean; errors: string[]}>}};
}

test('--check: a pure program passes (exit 0) and stdout is the JSON report only', {skip: !available}, () => {
  const {status, report} = check('pure.js');
  assert.equal(status, 0);
  assert.equal(report.verdict, 'pass');
});

test('--check: Math.random drifts (exit 1) and is named as a hazard', {skip: !available}, () => {
  const {status, report} = check('random.js');
  assert.equal(status, 1);
  assert.equal(report.verdict, 'drift');
  assert.ok(report.seeds[0].hazards.includes('Math.random'));
});

test('--check: Date.now drifts (exit 1)', {skip: !available}, () => {
  const {status, report} = check('clock.js');
  assert.equal(status, 1);
  assert.equal(report.verdict, 'drift');
});

test('--check: a seeded WebGL program passes (exit 0)', {skip: !webgl && 'headless Chromium has no WebGL'}, () => {
  const {status, report} = check('webgl.js');
  assert.equal(status, 0);
  assert.equal(report.verdict, 'pass');
});

test('--check: a WebGL program coloured by Math.random drifts (exit 1)', {skip: !webgl && 'headless Chromium has no WebGL'}, () => {
  const {status, report} = check('webgl-drift.js');
  assert.equal(status, 1);
  assert.equal(report.verdict, 'drift');
});

test('--check --frames 2: a deterministic animation passes at every frame', {skip: !available}, () => {
  const {status, report} = check('animated.js', 2);
  assert.equal(status, 0);
  assert.equal(report.verdict, 'pass');
  assert.equal(report.frames, 2);
});

test('--check: an animation that diverges after frame 1 passes with one frame and drifts with two', {skip: !available}, () => {
  const one = check('animated-drift.js');
  assert.equal(one.status, 0);
  const two = check('animated-drift.js', 2);
  assert.equal(two.status, 1);
  assert.equal(two.report.verdict, 'drift');
  assert.deepEqual(two.report.seeds[0].driftFrames, [2]);
});


test('--check --json preserves a browser-launch harness error as exit 2 with a report', () => {
  const result = check('pure.js', 1, [], {...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve(FIXTURES, 'no-browser-builds')});
  assert.equal(result.status, 2);
  assert.equal(result.report.verdict, 'harness');
  assert.equal(result.report.ok, false);
});

test('--check --json rejects invalid run counts and conflicting capture modes without hanging', () => {
  for (const extra of [['--runs', 'Infinity'], ['--frames', '0'], ['--timeout-ms', '0'], ['--shoot', 'unused']]) {
    const result = check('pure.js', 1, extra);
    assert.equal(result.status, 2);
    assert.equal(result.report.verdict, 'harness');
  }
});

test('--check requires completion and refuses a script that throws after reporting traits', {skip: !available}, () => {
  for (const script of ['incomplete.js', 'execution-error.js']) {
    const result = check(script, 1, ['--count', '1', '--timeout-ms', '150']);
    assert.equal(result.status, 2);
    assert.equal(result.report.verdict, 'harness');
    if (script === 'execution-error.js') assert.ok(result.report.seeds[0].errors.includes('page_error'));
  }
});

test('--check captures late trait-only drift and its randomness source', {skip: !available}, () => {
  const result = check('late-traits.js', 2, ['--count', '1']);
  assert.equal(result.status, 1);
  assert.deepEqual(result.report.seeds[0].driftFrames, [2]);
  assert.ok(result.report.seeds[0].hazards.includes('Math.random'));
});

test('--check captures late exceptions even after abx.done', {skip: !available}, () => {
  const result = check('late-error.js', 2, ['--count', '1']);
  assert.equal(result.status, 2);
  assert.ok(result.report.seeds[0].errors.includes('page_error'));
});

test('--check names network-driven drift', {skip: !available}, () => {
  const result = check('network.js', 1, ['--count', '1']);
  assert.equal(result.status, 1);
  assert.ok(result.report.seeds[0].hazards.includes('fetch'));
});
