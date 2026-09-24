import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {
  CREATE2_PROXY,
  create2CalldataFromSalt,
  predictCreate2AddressFromSalt,
} from '@artblocks/abx-sdk';
import {contractInitcode, sponsoredContractPlan} from '../src/commands/contract.js';

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

test('sponsored deploy-contract becomes an exact CREATE2 proxy call with a predicted address', () => {
  const initcode = '0x60006000f3';
  const salt = `0x${'ab'.repeat(32)}` as const;
  const plan = sponsoredContractPlan(initcode, salt, 84532, 'test hook');
  assert.equal(plan.address, predictCreate2AddressFromSalt(salt, initcode));
  assert.equal(plan.transaction.to, CREATE2_PROXY);
  assert.equal(plan.transaction.data, create2CalldataFromSalt(salt, initcode));
  assert.equal(plan.transaction.value, '0x0');
  assert.equal(plan.transaction.chainId, 84532);
  assert.equal(plan.transaction.fields?.constructorCaller, CREATE2_PROXY);
});
