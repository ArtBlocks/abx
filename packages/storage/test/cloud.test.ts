import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CloudStorageBackend, deriveSigningKey, sigv4Signature} from '../src/index.js';

const cloudCfg = (publicBase?: string) => ({
  endpoint: 'https://s3.us-east-1.amazonaws.com',
  bucket: 'b',
  region: 'us-east-1',
  accessKeyId: 'k',
  secretAccessKey: 's',
  publicBase,
});

test('cloud locator: null without a public base, a direct object URL with one', async () => {
  const hash = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
  assert.equal(await new CloudStorageBackend(cloudCfg()).locator(hash), null);
  assert.equal(
    await new CloudStorageBackend(cloudCfg('https://cdn.you.xyz/')).locator(hash),
    `https://cdn.you.xyz/abx/content/${'ab'.repeat(32)}`,
  );
});

test('cloud putDirectory requires a public read base (baked on-chain)', async () => {
  await assert.rejects(
    () => new CloudStorageBackend(cloudCfg()).putDirectory([{name: '0.png', bytes: new Uint8Array([1]), contentType: 'image/png'}]),
    /public read base/,
  );
});

// The cloud backend's correctness rests entirely on SigV4. We can't reach a real
// bucket here, but the signing is pure and AWS publishes canonical test vectors —
// so we verify the crypto exactly, offline.

test('SigV4 signing key matches AWS\'s documented derivation', () => {
  // From the AWS "derive the signing key" worked example.
  const key = deriveSigningKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam');
  assert.equal(Buffer.from(key).toString('hex'), 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
});

test('SigV4 matches the AWS sig-v4-test-suite "get-vanilla" vector end to end', () => {
  const out = sigv4Signature({
    method: 'GET',
    canonicalUri: '/',
    canonicalQuery: '',
    headers: {host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z'},
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    amzDate: '20150830T123600Z',
    dateStamp: '20150830',
    region: 'us-east-1',
    service: 'service',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  });
  assert.equal(out.signedHeaders, 'host;x-amz-date');
  assert.equal(out.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});
