import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertUriBaseLockable, isAbxIoUri} from '../src/uri-lock.js';

test('ABX-hosted URI bases are recognized across the apex and all subdomains', () => {
  for (const uri of [
    'https://abx.io/t',
    'https://services.abx.io/t',
    'https://resolver.abx.io/t',
    'https://api.abx.io/c',
    'HTTPS://SERVICES.ABX.IO/t',
    'https://services.abx.io.:443/t',
  ]) {
    assert.equal(isAbxIoUri(uri), true, uri);
    assert.throws(() => assertUriBaseLockable(uri), /Refusing to lock URI configuration.*domain you control/i);
  }
});

test('lookalike and creator-controlled domains remain lockable', () => {
  for (const uri of [
    '',
    'data:application/json;base64,e30=',
    'ipfs://bafybeigdyrzt',
    'https://tokens.creator.example/t',
    'https://abx.io.evil.example/t',
    'https://myabx.io/t',
  ]) {
    assert.equal(isAbxIoUri(uri), false, uri);
    assert.doesNotThrow(() => assertUriBaseLockable(uri));
  }
});
