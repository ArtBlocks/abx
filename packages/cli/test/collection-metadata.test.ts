import assert from 'node:assert/strict';
import {test} from 'node:test';
import {encodeTag, METADATA_FIELD as F, METADATA_REPRESENTATION as R} from '@artblocks/abx-sdk';
import {toHex} from 'viem';
import {authorshipContractFields} from '../src/ownerops.js';
import {loadCollectionMetadata, validateCollectionMetadata} from '../src/collection-metadata.js';

test('collection artwork flags do not replace the image field inherited by token art', () => {
  assert.deepEqual(authorshipContractFields({'banner-image': 'https://example.com/banner.png', 'featured-image': 'ipfs://featured'}), [
    {field: encodeTag(F.bannerImage), representation: encodeTag(R.url), value: toHex('https://example.com/banner.png')},
    {field: encodeTag(F.featuredImage), representation: encodeTag(R.url), value: toHex('ipfs://featured')}
  ]);
  assert.throws(() => authorshipContractFields({'banner-image': 'true'}), /needs an image URI/);
});

test('marketplace validation names missing and malformed fields without assuming provider ingestion', () => {
  const document = {name: 'Work', description: 'Description', image: 'data:image/png;base64,AAAA', external_link: 'https://example.com', banner_image: 'ipfs://banner', featured_image: 'ar://featured'};
  assert.equal(validateCollectionMetadata(document).valid, true);
  assert.deepEqual(validateCollectionMetadata(null).invalid, ['document']);
  assert.deepEqual(validateCollectionMetadata({...document, external_link: 'https://'}).invalid, ['external_link']);
  assert.deepEqual(validateCollectionMetadata({...document, image: '', banner_image: 42}), {
    profile: 'marketplace', valid: false, missing: ['image'], invalid: ['banner_image']
  });
});

test('handoff metadata inspection reads one bounded document and rejects oversized or non-object content', async () => {
  const uri = 'data:application/json;base64,' + Buffer.from('{"name":"Work"}').toString('base64');
  assert.deepEqual(await loadCollectionMetadata(uri), {name: 'Work'});
  let calls = 0;
  const fake: typeof fetch = async () => {calls++; return new Response(JSON.stringify({name: 'Work'}));};
  assert.deepEqual(await loadCollectionMetadata('https://example.com/metadata', fake), {name: 'Work'});
  assert.equal(calls, 1);
  await assert.rejects(loadCollectionMetadata('https://example.com/metadata', async () => new Response('x'.repeat(1024 * 1024 + 1))), /read budget/);
  await assert.rejects(loadCollectionMetadata('data:application/json;base64,W10='), /JSON object/);
});
