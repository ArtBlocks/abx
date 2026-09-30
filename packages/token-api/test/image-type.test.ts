// Stored image bytes are served with their DECLARED type (`abx_image_type`, renderer spec v12).
// Through v11 both planes labelled every inline/reader image `image/svg+xml`, so a JPEG staged with
// `--onchain-image` drew as a broken image. The resolver must agree with the renderer on the label.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bytesToHex, stringToHex} from 'viem';
import type {MetadataField, ProjectState, TokenState} from '@artblocks/abx-sdk';
import type {StorageBackend} from '@artblocks/abx-storage';
import {buildContractMetadata, buildTokenMetadata, type ArtifactEntry} from '../src/metadata.js';
import {resolveContent} from '../src/server.js';

const client = {} as never;
const ADDR = '0x0000000000000000000000000000000000000abc' as `0x${string}`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const text = (name: string, representation: string, value: string): MetadataField =>
  ({field: name, representation, value: stringToHex(value)}) as never;
const jpegImage = (): MetadataField => ({field: 'image', representation: 'inline', value: bytesToHex(JPEG)}) as never;

const projectState = (collectionFields: MetadataField[] = []): ProjectState =>
  ({address: ADDR, chainId: 11155111, name: 'Drift', collectionFields, tokens: [], paramHooks: null, maxInvocations: '1'}) as never;
const tokenState = (fields: MetadataField[]): TokenState =>
  ({tokenId: '0', lifecycle: 'live', owner: null, tokenURI: null, fields, lockedFields: []}) as never;
const storage = {id: 'memory', put: async () => {}, get: async () => null, has: async () => false} as StorageBackend;
const imageEntry = (json: Record<string, unknown>) => (json.artifacts as ArtifactEntry[]).find((e) => e.key === 'image')!;

test('the image route serves stored bytes with the declared type', async () => {
  const token = tokenState([jpegImage(), text('abx_image_type', 'inline', 'image/jpeg')]);
  const {contentType, body} = await resolveContent(projectState(), token, storage);
  assert.equal(contentType, 'image/jpeg');
  assert.deepEqual(new Uint8Array(body as Uint8Array), JPEG);
});

test('an unset type keeps the v11 SVG label', async () => {
  const {contentType} = await resolveContent(projectState(), tokenState([jpegImage()]), storage);
  assert.equal(contentType, 'image/svg+xml');
});

test('a collection-scope type covers the token; a token-scope type overrides it', async () => {
  const state = projectState([text('abx_image_type', 'inline', 'image/png')]);
  assert.equal((await resolveContent(state, tokenState([jpegImage()]), storage)).contentType, 'image/png');
  const overridden = tokenState([jpegImage(), text('abx_image_type', 'inline', 'image/jpeg')]);
  assert.equal((await resolveContent(state, overridden, storage)).contentType, 'image/jpeg');
});

test('malformed or non-inline declarations fall back exactly as the renderer does', async () => {
  for (const bad of ['text/html', 'image/png;x=1', 'image/png,<x>', 'IMAGE/PNG', 'image/']) {
    const token = tokenState([jpegImage(), text('abx_image_type', 'inline', bad)]);
    assert.equal((await resolveContent(projectState(), token, storage)).contentType, 'image/svg+xml', bad);
  }
  const nonInline = tokenState([jpegImage(), text('abx_image_type', 'url', 'image/jpeg')]);
  assert.equal((await resolveContent(projectState(), nonInline, storage)).contentType, 'image/svg+xml');
  // an invalid TOKEN value does not fall through to a valid collection one (the renderer's `_field`)
  const state = projectState([text('abx_image_type', 'inline', 'image/png')]);
  const invalidToken = tokenState([jpegImage(), text('abx_image_type', 'inline', 'nope')]);
  assert.equal((await resolveContent(state, invalidToken, storage)).contentType, 'image/svg+xml');
});

test('the artifacts manifest lists the image with its declared type and never lists the declaration', async () => {
  const token = tokenState([jpegImage(), text('abx_image_type', 'inline', 'image/jpeg')]);
  const json = await buildTokenMetadata(client, projectState(), token, 'http://node', 11155111);
  assert.equal(imageEntry(json).mimeType, 'image/jpeg');
  const keys = (json.artifacts as ArtifactEntry[]).map((e) => e.key);
  assert.ok(!keys.includes('abx_image_type'), 'a serving declaration is not an artifact');
  assert.equal(json.abx_image_type, undefined, 'never projected');

  const coll = await buildContractMetadata(client, projectState([text('abx_image_type', 'inline', 'image/png')]), 'http://node', 11155111);
  assert.equal(coll.abx_image_type, undefined);
  assert.ok(!((coll.artifacts as ArtifactEntry[] | undefined) ?? []).some((e) => e.key === 'abx_image_type'));
});
