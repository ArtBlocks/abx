// Stored image bytes are served with their declared `abx_image_type` (renderer spec v12). Before it,
// `--onchain-image` staged a JPEG behind a `reader` field and every plane served it as SVG — a broken
// image with bytes that matched the source exactly. The CLI must declare a raster's type as it stores it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {hexToString} from 'viem';
import {decodeTag} from '@artblocks/abx-sdk';
import {imageTypeField, storedImageTypeFor} from '../src/ownerops.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');

test('SVG needs no declaration; a raster declares the type its extension names', () => {
  assert.equal(storedImageTypeFor(SVG, 'art.svg'), null);
  assert.equal(storedImageTypeFor(SVG, 'art'), null, 'SVG is recognised by its leading tag, whatever the name');
  assert.equal(storedImageTypeFor(JPEG, 'cat.jpg'), 'image/jpeg');
  assert.equal(storedImageTypeFor(JPEG, 'cat.JPEG'), 'image/jpeg');
  for (const [name, type] of [['a.png', 'image/png'], ['a.gif', 'image/gif'], ['a.webp', 'image/webp'], ['a.avif', 'image/avif']]) {
    assert.equal(storedImageTypeFor(JPEG, name), type);
  }
});

test('a file no browser draws as an image is refused before anything is staged', () => {
  assert.throws(() => storedImageTypeFor(JPEG, 'scan.tiff'), /is image\/tiff/);
  assert.throws(() => storedImageTypeFor(JPEG, 'layers.psd'), /must be SVG, PNG, JPEG, GIF, WebP or AVIF/);
  assert.throws(() => storedImageTypeFor(JPEG, 'clip.mp4'), /is video\/mp4/);
  assert.throws(() => storedImageTypeFor(JPEG, 'noext'), /no recognised image extension/);
});

test('the declaration is an inline abx_image_type field', () => {
  const f = imageTypeField('image/jpeg');
  assert.equal(decodeTag(f.field), 'abx_image_type');
  assert.equal(decodeTag(f.representation), 'inline');
  assert.equal(hexToString(f.value), 'image/jpeg');
});

const CLI = resolve(import.meta.dirname, '../src/main.ts');
const plain = (s: string) => s.replace(/\[[0-9;]*m/g, '');
function run(args: string[]): {code: number; out: string} {
  try {
    const out = execFileSync('node', ['--import', 'tsx', CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
      timeout: 30_000,
    });
    return {code: 0, out: plain(out)};
  } catch (e) {
    const err = e as {status?: number; stdout?: string; stderr?: string};
    return {code: err.status ?? 1, out: plain((err.stdout ?? '') + (err.stderr ?? ''))};
  }
}

const dir = mkdtempSync(join(tmpdir(), 'abx-image-type-'));
writeFileSync(join(dir, 'cat.jpg'), JPEG);
writeFileSync(join(dir, 'scan.tiff'), JPEG);
const FOR = '0x000000000000000000000000000000000000dEaD';

test('deploy --onchain-image --dry-run names the declared type for a JPEG', () => {
  const {code, out} = run(['deploy', '--image', join(dir, 'cat.jpg'), '--onchain-image', '--name', 'Cat', '--symbol', 'CAT', '--for', FOR, '--dry-run']);
  assert.equal(code, 0, out);
  assert.match(out, /declares image\/jpeg \(abx_image_type\)/);
});

test('deploy --onchain-image --dry-run refuses a TIFF', () => {
  const {code, out} = run(['deploy', '--image', join(dir, 'scan.tiff'), '--onchain-image', '--name', 'Scan', '--symbol', 'SCN', '--for', FOR, '--dry-run']);
  assert.notEqual(code, 0);
  assert.match(out, /scan\.tiff is image\/tiff/);
});
