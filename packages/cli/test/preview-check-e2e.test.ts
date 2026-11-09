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
const webgl = available && (await webglAvailable());

function check(script: string, frames = 1) {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', CLI, 'preview', '--script', resolve(FIXTURES, script), '--check', '--runs', '2', '--count', '2', '--json', ...(frames > 1 ? ['--frames', String(frames)] : [])],
    {encoding: 'utf8', timeout: 90_000},
  );
  return {status: r.status, report: JSON.parse(r.stdout) as {ok: boolean; verdict: string; frames: number; seeds: Array<{hazards: string[]; driftFrames: number[]}>}};
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
