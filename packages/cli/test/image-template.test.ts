import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTag } from '@artblocks/abx-sdk';
import { hexToString, toHex } from 'viem';
import { collectionImageTemplate, resolveImageNamespace } from '../src/image-template.js';

test('CLI image paths and worker namespaces agree, including custom bucket prefixes and filenames', () => {
  assert.equal(
    collectionImageTemplate('https://cdn.test/orbit', 8453),
    'https://cdn.test/orbit/8453/{contract}/{id}.png',
  );
  assert.equal(
    collectionImageTemplate('https://cdn.test/orbit', 8453, 'https://cdn.test'),
    'https://cdn.test/8453/{contract}/orbit/{id}.png',
  );
  assert.equal(
    collectionImageTemplate('https://cdn.test/frame-{id}.png', 8453, 'https://cdn.test'),
    'https://cdn.test/8453/{contract}/frame-{id}.png',
  );
  const template = collectionImageTemplate('https://cdn.test', 8453);
  const contract = '0xAbCd000000000000000000000000000000000001' as const;
  const field = { field: encodeTag('image'), representation: encodeTag('url-template'), value: toHex(template) };
  const [resolved] = resolveImageNamespace([field], contract);
  assert.equal(
    hexToString(resolved!.value),
    'https://cdn.test/8453/0xabcd000000000000000000000000000000000001/{id}.png',
  );
  assert.equal(hexToString(field.value), template);
});
