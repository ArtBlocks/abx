import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stringToHex} from 'viem';
import {DEFAULT_STORED_IMAGE_TYPE, isDeclarableImageType, storedImageType, type MetadataField} from '../src/index.js';

const type = (representation: string, value: string): MetadataField =>
  ({field: 'abx_image_type', representation, value: stringToHex(value)}) as never;

test('declarable types mirror AbxMetadataRenderer._isImageType', () => {
  for (const ok of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/vnd.adobe.photoshop', `image/${'a'.repeat(58)}`]) {
    assert.ok(isDeclarableImageType(ok), ok);
  }
  for (const bad of ['', 'image/', 'text/html', 'image/png;x=1', 'image/png,', 'IMAGE/PNG', 'image/PNG', 'image/-png', ' image/png', `image/${'a'.repeat(59)}`]) {
    assert.ok(!isDeclarableImageType(bad), bad);
  }
});

test('token scope, else collection scope, else SVG', () => {
  assert.equal(storedImageType([], []), DEFAULT_STORED_IMAGE_TYPE);
  assert.equal(storedImageType(undefined, [type('inline', 'image/png')]), 'image/png');
  assert.equal(storedImageType([type('inline', 'image/jpeg')], [type('inline', 'image/png')]), 'image/jpeg');
  // only inline counts; a present-but-invalid token value does not fall through (renderer `_field`)
  assert.equal(storedImageType([type('url', 'image/jpeg')], []), DEFAULT_STORED_IMAGE_TYPE);
  assert.equal(storedImageType([type('inline', 'bogus')], [type('inline', 'image/png')]), DEFAULT_STORED_IMAGE_TYPE);
});
