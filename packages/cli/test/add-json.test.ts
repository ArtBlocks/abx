import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localAddJsonResult} from '../src/commands/project.js';

const ADDRESS = '0xb5D472600107a56c0A36838FFf7030A864439a30';

test('local add JSON identifies the local surface and completed scan', () => {
  assert.deepEqual(
    localAddJsonResult({chainId: 11155111, address: ADDRESS, scanFloor: '11238537', eventCount: 9, tokenCount: 1}),
    {
      target: {surface: 'local', name: null, url: null},
      chainId: 11155111,
      address: ADDRESS,
      status: 'live',
      scanFloor: '11238537',
      completed: true,
      backfilling: false,
      eventCount: 9,
      tokenCount: 1,
    },
  );
});
