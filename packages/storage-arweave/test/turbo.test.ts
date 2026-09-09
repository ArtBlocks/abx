import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TurboUploader, turboUploadId} from '../src/index.js';

test('turboUploadId: reads the normal {id}, AND Turbo\'s idempotent "already uploaded" dedup reply', () => {
  const TXID = 'cELQ6_Zxh9pODH0y24m7hqJBhKz1xFHtUjtvwTRpxiw'; // 43-char base64url arweave id
  // normal success shape
  assert.equal(turboUploadId({id: TXID}), TXID);
  // dedup: Turbo returns a plain-text sentence (not JSON) when the identical data item already exists
  const dedup = `Data item with ID ${TXID} has already been uploaded to this service!`;
  assert.equal(turboUploadId(dedup), TXID);
  // …and stream/JSON layers can surface that string as a char-indexed object — must still work
  assert.equal(turboUploadId({...dedup.split('')}), TXID);
  // genuinely-empty responses yield null (caller throws a diagnosable error)
  assert.equal(turboUploadId({}), null);
  assert.equal(turboUploadId({id: ''}), null);
  assert.equal(turboUploadId('upload failed'), null);
});

test('TurboUploader: rejects an arweave identity with no key, and an ethereum identity with no key', () => {
  assert.throws(() => new TurboUploader({kind: 'arweave', jwk: {kty: 'RSA', n: '', e: 'AQAB'}}), /needs an Arweave identity key/);
  assert.throws(() => new TurboUploader({kind: 'ethereum', privateKey: ''}), /needs a private key/);
});

test('TurboUploader: accepts a well-formed identity of each kind without touching the network', () => {
  // Construction only validates shape — it never imports turbo-sdk or reaches the network until
  // .upload()/.funding.* is actually called (see the class doc).
  assert.doesNotThrow(() => new TurboUploader({kind: 'arweave', jwk: {kty: 'RSA', n: 'bW9kdWx1cw', e: 'AQAB'}}));
  assert.doesNotThrow(() => new TurboUploader({kind: 'ethereum', privateKey: '0xac0976bfec70ba57a56a97f5b3b26f4b7cb17df3edc816e14e77dc22a8ed3a48'}));
  assert.doesNotThrow(() => new TurboUploader({kind: 'ethereum-remote', address: '0xF00', signMessage: async () => new Uint8Array()}));
});

test('TurboUploader: funding.address() is a pure derivation — no SDK import, no network', async () => {
  const eth = new TurboUploader({kind: 'ethereum', privateKey: '0xac0976bfec70ba57a56a97f5b3b26f4b7cb17df3edc816e14e77dc22a8ed3a48'});
  assert.match(await eth.funding.address(), /^0x[0-9a-fA-F]{40}$/);

  const remote = new TurboUploader({kind: 'ethereum-remote', address: '0xF00', signMessage: async () => new Uint8Array()});
  assert.equal(await remote.funding.address(), '0xF00');

  const arweave = new TurboUploader({kind: 'arweave', jwk: {kty: 'RSA', n: 'bW9kdWx1cw', e: 'AQAB'}});
  assert.match(await arweave.funding.address(), /^[A-Za-z0-9_-]+$/); // base64url(sha256(n))
});
