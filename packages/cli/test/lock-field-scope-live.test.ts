// End-to-end against a REAL deployed fixture: `abx lock-field --field
// animation_url --token 0` used to report "would succeed" — and would have succeeded — on this
// fixture, whose `animation_url` is COLLECTION-scoped (a field renderer, shared across every
// token). Locking the empty token-scope slot freezes nothing a viewer actually sees, on a
// PERMANENT operation. `lock-field-scope.test.ts` covers the decision logic against mocks; this
// pins the real on-chain read against the same live fixture `edition-ownerops-live.test.ts` uses
// (`detectTokenKind`/field reads have no injectable client in these command bodies, so a live
// fixture is the established pattern here — see that file's header).
//
// Every case below runs `--dry-run` only: the check fires BEFORE `runWrite`/`gatedSend` (by
// construction — it's a separate call ahead of both), so a real send would refuse/warn identically;
// this suite never signs or sends against the shared fixture.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

const CLI = resolve(import.meta.dirname, '../src/main.ts');
// base-sepolia, kind: code — same permanent fixture as edition-ownerops-live.test.ts. Its
// `animation_url` is a COLLECTION-scope field renderer (confirmed via `abx tokenuri --json`:
// `abx_provenance` names it `"source": "renderer"`, `"note": "... [collection]"`); `description` is
// unset in BOTH scopes.
const FIXTURE = '0xC75761FBC5291014963B7FF45760326E7429C2Ee';

const plain = (s: string) => s.replace(/\[[0-9;]*m/g, '');

function run(args: string[]): {code: number; out: string} {
  try {
    const out = execFileSync('node', ['--import', 'tsx', CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
      timeout: 30_000,
    });
    return {code: 0, out: plain(out)};
  } catch (e) {
    const err = e as {status?: number; stdout?: string; stderr?: string};
    return {code: err.status ?? 1, out: plain((err.stdout ?? '') + (err.stderr ?? ''))};
  }
}

test('lock-field: WRONG scope (default token) on a COLLECTION-scoped field is REFUSED, naming --collection', () => {
  const {code, out} = run(['lock-field', FIXTURE, '--field', 'animation_url', '--dry-run']);
  assert.notEqual(code, 0, `a wrong-scope permanent lock must refuse\n${out}`);
  assert.match(out, /currently served from COLLECTION scope/);
  assert.match(out, new RegExp(`abx lock-field ${FIXTURE} --field animation_url --collection`));
  assert.match(out, /--force-field/); // names the escape hatch
});

test('lock-field: the RIGHT scope (--collection) for the same field proceeds normally — no refusal', () => {
  const {code, out} = run(['lock-field', FIXTURE, '--field', 'animation_url', '--collection', '--dry-run']);
  assert.equal(code, 0, `the correct scope must not be refused\n${out}`);
  assert.doesNotMatch(out, /LOCKING A SLOT/);
  assert.match(out, /would succeed/); // reaches the real dry-run simulation
});

test('lock-field: --force-field on the wrong scope WARNS LOUDLY but still proceeds to the dry-run preview', () => {
  const {code, out} = run(['lock-field', FIXTURE, '--field', 'animation_url', '--force-field', '--dry-run']);
  assert.equal(code, 0, `--force-field must proceed, not refuse\n${out}`);
  assert.match(out, /LOCKING A SLOT THAT IS NOT WHAT'S DISPLAYED/);
  assert.match(out, /DOES NOT FREEZE THAT VALUE/);
  assert.match(out, /would succeed/); // still reaches the real dry-run simulation after warning
});

test('lock-field: a field genuinely unset in BOTH scopes proceeds with no refusal AND no warning', () => {
  const {code, out} = run(['lock-field', FIXTURE, '--field', 'description', '--dry-run']);
  assert.equal(code, 0, `an empty-both-scopes lock is a legitimate no-op-today freeze, not a bug\n${out}`);
  assert.doesNotMatch(out, /LOCKING A SLOT/);
  assert.match(out, /would succeed/);
});
