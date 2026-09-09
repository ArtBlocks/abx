// doctor's funding line has THREE states, not two.
//
// A cold sandbox agent had `0.000000000848940602 ETH` — 848 gwei, enough for nothing — and doctor
// reported it as **funded**, in full wei precision, with no faucet link. The agent went on to prepare
// a deploy it could not send and listed "insufficient-funds signal is too quiet" as its top friction.
// `balance > 0n` was the wrong test: dust is not funding.
//
// The floor is a READOUT threshold, not a refusal — we do not estimate anyone's gas, and a cheap L2
// deploy below it is the caller's call. It only decides whether doctor hands over a faucet link.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeBalance, describeMissingRemoteToken} from '../src/commands/scaffold.ts';

const ADDR = '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C' as const;
/** Minimal stand-in: `describeBalance` only ever calls `getBalance`. */
const clientWith = (wei: bigint) => ({getBalance: async () => wei}) as never;

test('exactly zero reads as empty, with a faucet link', async () => {
  const out = await describeBalance(clientWith(0n), ADDR);
  assert.match(out, /^empty — fund it \(/);
  assert.match(out, /faucet/i);
});

test('dust does NOT read as funded — the clean-room regression', async () => {
  // the agent's actual balance: 848_940_602 wei
  const out = await describeBalance(clientWith(848_940_602n), ADDR);
  assert.doesNotMatch(out, /funded/, 'dust must never be called funded');
  assert.match(out, /too little to deploy/);
  assert.match(out, /faucet/i, 'and it must hand over a faucet link');
});

test('a usable balance reads as funded, trimmed to something a human can scan', async () => {
  const out = await describeBalance(clientWith(6_200_289_849_866_882n), ADDR);
  assert.match(out, /^funded /);
  // 0.006200289849866882 → 0.006200 trimmed of trailing zeros
  assert.match(out, /funded 0\.0062 ETH/);
  assert.doesNotMatch(out, /849866882/, 'wei precision is unreadable and this line is for glancing at');
});

test('the floor is exclusive at the boundary', async () => {
  assert.match(await describeBalance(clientWith(999_999_999_999_999n), ADDR), /too little/);
  assert.match(await describeBalance(clientWith(1_000_000_000_000_000n), ADDR), /^funded /);
});

test('doctor routes a missing first-party credential into OAuth login', () => {
  assert.equal(describeMissingRemoteToken('ABX'), 'no token — run abx auth login');
  assert.equal(describeMissingRemoteToken('another-provider'), 'no token');
});
