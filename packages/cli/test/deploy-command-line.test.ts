// The "reproduce this exact preview" line printed by every deploy dry run must carry the
// authorship flags too. They are written on-chain as collection fields, so a re-run that drops
// them deploys a different collection than the one that was previewed. `abx deploy` already
// carried them; deploy-series and deploy-code dropped them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deployCodeCommandLine, deployCommandLine, deploySeriesCommandLine} from '../src/commands/deploy.js';
import {AUTHORSHIP_DEPLOY_FIELDS} from '../src/ownerops.js';

const SALT = '0x' + '11'.repeat(32);
const authorship = {creator: 'Cadence', 'display-notes': 'notes', 'creator-links': 'https://a.example', license: 'CC0'};

for (const [name, build] of [
  ['deploy', deployCommandLine],
  ['deploy-series', deploySeriesCommandLine],
  ['deploy-code', deployCodeCommandLine],
] as const) {
  test(`${name}: the reproduce line keeps every authorship flag`, () => {
    const line = build({name: 'N', symbol: 'S', ...authorship}, SALT);
    for (const [flag] of AUTHORSHIP_DEPLOY_FIELDS) {
      assert.equal(line.split(`--${flag} `).length - 1, 1, `--${flag} should appear once in: ${line}`);
    }
    assert.ok(line.includes("--creator Cadence") || line.includes("--creator 'Cadence'"), line);
  });

  test(`${name}: unset authorship flags are not emitted`, () => {
    const line = build({name: 'N', symbol: 'S'}, SALT);
    for (const [flag] of AUTHORSHIP_DEPLOY_FIELDS) assert.ok(!line.includes(`--${flag}`), line);
  });
}
