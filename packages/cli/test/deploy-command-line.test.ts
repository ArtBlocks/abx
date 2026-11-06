// Every deploy dry run prints a "reproduce this exact preview" line. The authorship flags are
// written on-chain as collection fields, so the line has to carry them with their values intact.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {deployCodeCommandLine, deployCommandLine, deploySeriesCommandLine} from '../src/commands/deploy.js';
import {AUTHORSHIP_DEPLOY_FIELDS} from '../src/ownerops.js';

const SALT = '0x' + '11'.repeat(32);
// Spaces, an apostrophe and a `$` so the values only survive if the line is quoted correctly.
const authorship: Record<string, string> = {
  creator: "Jo O'Neil",
  'display-notes': 'notes with $HOME and spaces',
  'creator-links': 'https://a.example https://b.example',
  license: 'CC0',
};

// Split the printed line the way a POSIX shell would, so the test checks what a user who pastes it gets.
function shellWords(line: string): string[] {
  const r = spawnSync('sh', ['-c', `printf '%s\\0' ${line.replace(/^abx /, '')}`], {encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\0').slice(0, -1);
}

for (const [name, build] of [
  ['deploy', deployCommandLine],
  ['deploy-series', deploySeriesCommandLine],
  ['deploy-code', deployCodeCommandLine],
] as const) {
  test(`${name}: the reproduce line keeps every authorship flag and value`, () => {
    const line = build({name: 'N', symbol: 'S', ...authorship}, SALT);
    const words = shellWords(line);
    for (const [flag] of AUTHORSHIP_DEPLOY_FIELDS) {
      const at = words.indexOf(`--${flag}`);
      assert.notEqual(at, -1, `--${flag} missing from: ${line}`);
      assert.equal(words.lastIndexOf(`--${flag}`), at, `--${flag} repeated in: ${line}`);
      assert.equal(words[at + 1], authorship[flag], `--${flag} value in: ${line}`);
    }
  });

  test(`${name}: unset authorship flags are not emitted`, () => {
    const line = build({name: 'N', symbol: 'S'}, SALT);
    for (const [flag] of AUTHORSHIP_DEPLOY_FIELDS) assert.ok(!line.includes(`--${flag}`), line);
  });
}
