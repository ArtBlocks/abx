import assert from 'node:assert/strict';
import test from 'node:test';
import type {Address, PublicClient} from '@artblocks/abx-sdk';
import {warnUnfunded} from '../src/commands/deploy.js';

test('sponsored deploys skip the native-balance and faucet preflight', async () => {
  let balanceReads = 0;
  const publicClient = {
    getBalance: async () => {
      balanceReads += 1;
      return 1n;
    },
  } as unknown as PublicClient;
  const wallet = '0x0000000000000000000000000000000000000001' as Address;

  await warnUnfunded(publicClient, wallet, 'sponsor');
  assert.equal(balanceReads, 0, 'the service-funded lane must not inspect or require wallet gas');

  await warnUnfunded(publicClient, wallet, 'send');
  assert.equal(balanceReads, 1, 'self-funded lanes still retain the native-balance preflight');
});
