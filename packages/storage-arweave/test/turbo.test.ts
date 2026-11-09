import {test} from 'node:test';
import {generateKeyPairSync, verify, constants} from 'node:crypto';
import {Readable} from 'node:stream';
import type {TurboAuthenticatedClient} from '@ardrive/turbo-sdk';
import assert from 'node:assert/strict';
import {hexToBytes, recoverMessageAddress, toHex, type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {TurboUploader, turboUploadId} from '../src/index.js';
import {localEthereumDataItemSigner, remoteEthereumDataItemSigner} from '../src/turbo.js';

const ETH_KEY = '0xac0976bfec70ba57a56a97f5b3b26f4b7cb17df3edc816e14e77dc22a8ed3a48' as const;

const asSignature = (bytes: Uint8Array): Hex => toHex(bytes);

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
  assert.doesNotThrow(() => new TurboUploader({kind: 'ethereum', privateKey: ETH_KEY}));
  assert.doesNotThrow(() => new TurboUploader({kind: 'ethereum-remote', address: '0xF00', signMessage: async () => new Uint8Array()}));
});

test('TurboUploader: funding.address() is a pure derivation — no SDK import, no network', async () => {
  const eth = new TurboUploader({kind: 'ethereum', privateKey: ETH_KEY});
  assert.match(await eth.funding.address(), /^0x[0-9a-fA-F]{40}$/);

  const remote = new TurboUploader({kind: 'ethereum-remote', address: '0xF00', signMessage: async () => new Uint8Array()});
  assert.equal(await remote.funding.address(), '0xF00');

  const arweave = new TurboUploader({kind: 'arweave', jwk: {kty: 'RSA', n: 'bW9kdWx1cw', e: 'AQAB'}});
  assert.match(await arweave.funding.address(), /^[A-Za-z0-9_-]+$/); // base64url(sha256(n))
});

test('local Ethereum Turbo signer uses viem and emits the 65-byte data-item signature shape', async () => {
  const account = privateKeyToAccount(ETH_KEY);
  const signer = localEthereumDataItemSigner(ETH_KEY);
  const message = new TextEncoder().encode('ABX Turbo local signer');
  const signature = await signer.sign(message);

  assert.deepEqual(signer.publicKey, Buffer.from(hexToBytes(account.publicKey)));
  assert.equal(signer.signatureType, 3);
  assert.equal(signer.ownerLength, 65);
  assert.equal(signer.signatureLength, 65);
  assert.equal(signature.byteLength, 65);
  assert.equal(await recoverMessageAddress({message: {raw: message}, signature: asSignature(signature)}), account.address);
});

test('remote Ethereum Turbo signer delegates signatures and recovers the wallet public key with viem', async () => {
  const account = privateKeyToAccount(ETH_KEY);
  const signed: Uint8Array[] = [];
  const signer = await remoteEthereumDataItemSigner(async (message) => {
    signed.push(message);
    return account.signMessage({message: {raw: message}});
  });
  const message = new TextEncoder().encode('ABX Turbo remote signer');
  const signature = await signer.sign(message);

  assert.equal(signed.length, 2); // one public-key challenge, then the data item
  assert.deepEqual(signer.publicKey, Buffer.from(hexToBytes(account.publicKey)));
  assert.equal(signature.byteLength, 65);
  assert.equal(await recoverMessageAddress({message: {raw: message}, signature: asSignature(signature)}), account.address);
});

test('remote Ethereum Turbo signer rejects malformed wallet signatures before constructing a client', async () => {
  await assert.rejects(remoteEthereumDataItemSigner(async () => '0xdeadbeef'), /invalid 65-byte hex signature/);
});

test('Turbo SDK accepts the viem-backed structural signer without replacing it', async () => {
  const uploader = new TurboUploader({kind: 'ethereum', privateKey: ETH_KEY});
  const client = await (
    uploader as unknown as {buildClient(): Promise<{uploadFile?: unknown}>}
  ).buildClient();

  assert.equal(typeof client.uploadFile, 'function');
});


for (const remote of [false, true]) {
  test(`Turbo 2 retains the ${remote ? 'remote' : 'local'} viem signer for data items and signed requests`, async (t) => {
    const {EthereumSigner} = await import('@ardrive/turbo-sdk');
    t.mock.method(EthereumSigner.prototype, 'sign', () => { throw new Error('must not use ethers-v5 signing'); });
    const account = privateKeyToAccount(ETH_KEY);
    const uploader = new TurboUploader(remote ? {
      kind: 'ethereum-remote', address: account.address,
      signMessage: (message) => account.signMessage({message: {raw: message}}),
    } : {kind: 'ethereum', privateKey: ETH_KEY});
    const client = await (uploader as unknown as {buildClient(): Promise<TurboAuthenticatedClient>}).buildClient();
    const message = new TextEncoder().encode('Turbo 2 compatibility');
    const signature = await client.signer.signData(message);
    assert.equal(await recoverMessageAddress({message: {raw: message}, signature: toHex(signature)}), account.address);
    assert.equal(await client.signer.getNativeAddress(), account.address);
    const signed = await client.signer.signDataItem({
      fileStreamFactory: () => Readable.from(Buffer.from(message)), fileSizeFactory: () => message.byteLength,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of signed.dataItemStreamFactory() as Readable) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, signed.dataItemSizeFactory());
    assert.equal(bytes.readUInt16LE(0), 3);
    assert.equal(bytes.subarray(67, 132).toString('hex'), account.publicKey.slice(2));
  });
}

test('Turbo 2 retains RSA signing for Arweave without an x402 peer', async () => {
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 4096});
  const jwk = privateKey.export({format: 'jwk'});
  const uploader = new TurboUploader({kind: 'arweave', jwk: jwk as {kty: string; n: string; e: string}});
  const client = await (uploader as unknown as {buildClient(): Promise<TurboAuthenticatedClient>}).buildClient();
  const message = Buffer.from('Turbo Arweave compatibility');
  const signature = await client.signer.signData(message);
  assert.equal(verify('sha256', message, {key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_AUTO}, signature), true);
  assert.equal(await client.signer.getNativeAddress(), await uploader.funding.address());
});
