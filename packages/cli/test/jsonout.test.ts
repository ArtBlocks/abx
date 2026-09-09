import {test} from 'node:test';
import assert from 'node:assert/strict';
import {jsonMode, jsonSafe, withJson} from '../src/jsonout.js';
import type {Flags} from '../src/flags.js';

/**
 * The contract under test is one sentence: **under `--json`, stdout carries exactly one JSON document
 * and nothing else.** It exists because an integrator regex-scraped ANSI-coloured stdout for every
 * value, an escape code ended up inside a locator, that locator was written into a stored player URL,
 * and it 404'd in production — found only by inspecting stored bytes.
 *
 * So these tests care about the CHANNEL, not the formatting: a stray narration line on stdout is the
 * bug, and it is invisible until someone's parser breaks in production.
 */

/** Capture both streams around a call. `console.log` is what commands narrate through; the payload
 *  must arrive on process.stdout regardless of what happened to console.log. */
async function capture(run: () => Promise<void>): Promise<{out: string; err: string}> {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  (process.stdout as unknown as {write: unknown}).write = (chunk: string) => {
    out += chunk;
    return true;
  };
  (process.stderr as unknown as {write: unknown}).write = (chunk: string) => {
    err += chunk;
    return true;
  };
  try {
    await run();
  } finally {
    (process.stdout as unknown as {write: unknown}).write = realOut;
    (process.stderr as unknown as {write: unknown}).write = realErr;
  }
  return {out, err};
}

const jsonFlags = {json: 'true'} as unknown as Flags;
const plainFlags = {} as unknown as Flags;

test('jsonMode: presence is what counts, not the value (--json and --json=true both mean yes)', () => {
  assert.equal(jsonMode(jsonFlags), true);
  assert.equal(jsonMode({json: ''} as unknown as Flags), true);
  assert.equal(jsonMode(plainFlags), false);
});

test('stdout carries ONLY the payload — every narration line is diverted to stderr', async () => {
  const {out, err} = await capture(async () => {
    await withJson(jsonFlags, async () => {
      console.log('  ✓ deployed 0xabc  \x1b[2mnarration a human wants\x1b[0m');
      console.log('  step 2 of 4');
      return {address: '0xabc'};
    });
  });
  // The load-bearing assertion: stdout parses, whole, with nothing prepended.
  assert.deepEqual(JSON.parse(out), {address: '0xabc'});
  // Narration is DIVERTED, not suppressed — a human watching a deploy still needs to see it.
  assert.match(err, /deployed 0xabc/);
  assert.match(err, /step 2 of 4/);
});

test('console.log is restored afterwards, even when the body throws', async () => {
  const before = console.log;
  await assert.rejects(
    capture(async () => {
      await withJson(jsonFlags, async () => {
        throw new Error('deploy reverted');
      });
    }),
    /deploy reverted/,
  );
  // A leaked swap would send every later command's output to stderr — a silent, global corruption.
  assert.equal(console.log, before);
});

test('emit() wins when the body returns nothing — for a command that learns its value midway', async () => {
  const {out} = await capture(async () => {
    await withJson(jsonFlags, async (emit) => {
      emit({address: '0xdeployed', sent: true});
      console.log('…then twelve more steps that could each fail');
    });
  });
  // The point: a crash after the address is known still leaves the caller with the address.
  assert.deepEqual(JSON.parse(out), {address: '0xdeployed', sent: true});
});

test('the last emit wins, and a returned value overrides both', async () => {
  const {out: a} = await capture(async () => {
    await withJson(jsonFlags, async (emit) => {
      emit({stage: 'one'});
      emit({stage: 'two'});
    });
  });
  assert.equal(JSON.parse(a).stage, 'two');

  const {out: b} = await capture(async () => {
    await withJson(jsonFlags, async (emit) => {
      emit({stage: 'emitted'});
      return {stage: 'returned'};
    });
  });
  assert.equal(JSON.parse(b).stage, 'returned');
});

test('an emitted payload still reaches stdout when a later step throws', async () => {
  // The gap this closes: a command that establishes a fact (e.g. a minted token id) via emit(),
  // then fails on a later step, used to leave a --json caller with nothing at all — the thrown
  // error propagated before the payload was ever printed. The id is still the only place a caller
  // can recover it, so it must reach stdout even though the command overall failed.
  const {out, err} = await capture(async () => {
    await assert.rejects(
      withJson(jsonFlags, async (emit) => {
        emit({tokenId: '7', sent: false});
        throw new Error('metadata write did not simulate (RPC lag)');
      }),
      /metadata write did not simulate/,
    );
  });
  assert.deepEqual(JSON.parse(out), {tokenId: '7', sent: false});
  // The error itself is unchanged and still only on stderr — this adds a stdout payload, it doesn't
  // swallow or relocate the failure.
  assert.doesNotMatch(err, /metadata write did not simulate/);
});

test('nothing is printed on failure when the body never emitted anything (unchanged behavior)', async () => {
  const {out} = await capture(async () => {
    await assert.rejects(
      withJson(jsonFlags, async () => {
        throw new Error('deploy reverted');
      }),
      /deploy reverted/,
    );
  });
  assert.equal(out, '');
});

test('a command that emits nothing leaves stdout EMPTY and fails — never a `{}` a caller would trust', async () => {
  const prior = process.exitCode;
  const {out, err} = await capture(async () => {
    await withJson(jsonFlags, async () => {
      /* forgot to emit */
    });
  });
  assert.equal(out, '');
  assert.match(err, /produced no payload/);
  assert.equal(process.exitCode, 1);
  process.exitCode = prior;
});

test('without --json nothing changes: narration stays on stdout and no JSON is printed', async () => {
  const {out, err} = await capture(async () => {
    await withJson(plainFlags, async (emit) => {
      console.log('human output');
      emit({address: '0xabc'});
    });
  });
  assert.match(out, /human output/);
  assert.doesNotMatch(out, /0xabc/); // the payload is not printed on the human path
  assert.equal(err, '');
});

test('jsonSafe: bigints become decimal strings instead of throwing', () => {
  // Every on-chain number in a payload (supply, a token id, a block) arrives as a bigint, and
  // JSON.stringify refuses them outright — which would fail at the LAST line of a real deploy.
  const out = jsonSafe({block: 12345678901234567890n, nested: {ids: [1n, 2n]}, keep: 'text'});
  assert.deepEqual(out, {block: '12345678901234567890', nested: {ids: ['1', '2']}, keep: 'text'});
});
