import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'abx-sandbox-clean-'));

after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

test('sandbox status identifies the untouched template by content, never line count', () => {
  mkdirSync(resolve(fixtureRoot, 'scripts'), { recursive: true });
  mkdirSync(resolve(fixtureRoot, 'contributor/agent-eval'), { recursive: true });
  mkdirSync(resolve(fixtureRoot, '.sandbox-untouched'));
  mkdirSync(resolve(fixtureRoot, '.sandbox-reported'));

  cpSync(resolve(repoRoot, 'scripts/sandbox-clean.sh'), resolve(fixtureRoot, 'scripts/sandbox-clean.sh'));
  cpSync(
    resolve(repoRoot, 'contributor/agent-eval/feedback-template.md'),
    resolve(fixtureRoot, 'contributor/agent-eval/feedback-template.md'),
  );

  const template = readFileSync(
    resolve(fixtureRoot, 'contributor/agent-eval/feedback-template.md'),
    'utf8',
  );
  writeFileSync(resolve(fixtureRoot, '.sandbox-untouched/FEEDBACK.md'), template);
  writeFileSync(
    resolve(fixtureRoot, '.sandbox-reported/FEEDBACK.md'),
    template.replace('# Sandbox feedback — <scenario name>', '# Sandbox feedback — completed report'),
  );

  const rows = JSON.parse(
    execFileSync('bash', ['scripts/sandbox-clean.sh', '--json'], { cwd: fixtureRoot, encoding: 'utf8' }),
  ) as Array<{ dir: string; state: string; feedbackLines: number }>;

  const untouched = rows.find(({ dir }) => dir === '.sandbox-untouched');
  const reported = rows.find(({ dir }) => dir === '.sandbox-reported');
  assert.equal(untouched?.state, 'void');
  assert.equal(reported?.state, 'filled');
  assert.equal(reported?.feedbackLines, untouched?.feedbackLines);
});
