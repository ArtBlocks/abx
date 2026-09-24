import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {contractInitcode} from '../src/commands/contract.js';

const dir = mkdtempSync(join(tmpdir(), 'abx-contract-command-'));
after(() => rmSync(dir, {recursive: true, force: true}));

test('deploy-contract reads Foundry bytecode and appends exact ABI-encoded constructor arguments', () => {
  const artifact = join(dir, 'Hook.json');
  writeFileSync(artifact, JSON.stringify({bytecode: {object: '0x60006000f3'}}));
  assert.equal(contractInitcode({artifact, 'constructor-args': '0x1234'}), '0x60006000f31234');
});

test('deploy-contract accepts complete initcode and rejects ambiguous or unlinked input', () => {
  const initcode = join(dir, 'initcode.hex');
  writeFileSync(initcode, '0x60006000f3\n');
  assert.equal(contractInitcode({initcode}), '0x60006000f3');
  assert.throws(() => contractInitcode({artifact: initcode, initcode}), /exactly one/);
  assert.throws(() => contractInitcode({initcode, 'constructor-args': '0x12'}), /already complete creation bytecode/);

  const unlinked = join(dir, 'Unlinked.json');
  writeFileSync(unlinked, JSON.stringify({bytecode: {object: '0x60__$abc$__'}}));
  assert.throws(() => contractInitcode({artifact: unlinked}), /unlinked library placeholders/);
});
