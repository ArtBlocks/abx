// `contentTypeFromPath` is a pure extension-map lookup with no storage-backend dependency. Storage keeps
// re-exporting it unchanged (see packages/cli/test/attach.test.ts for coverage exercising that
// re-export path specifically).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contentTypeFromPath} from '../src/mime.ts';

test('contentTypeFromPath: known extensions map, case-insensitively', () => {
  assert.equal(contentTypeFromPath('a.PNG'), 'image/png');
  assert.equal(contentTypeFromPath('song.flac'), 'audio/flac');
  assert.equal(contentTypeFromPath('cert.pdf'), 'application/pdf');
  assert.equal(contentTypeFromPath('readme.md'), 'text/markdown; charset=utf-8');
  assert.equal(contentTypeFromPath('ipfs://QmDir/master.tiff'), 'image/tiff');
});

test('contentTypeFromPath: no extension or an unknown one → the honest floor', () => {
  assert.equal(contentTypeFromPath('QmNoExtension'), 'application/octet-stream');
  assert.equal(contentTypeFromPath('archive.rar'), 'application/octet-stream');
});
