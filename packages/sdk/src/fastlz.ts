/**
 * FastLZ (level 1) — a pure, dependency-free codec whose output is byte-compatible with
 * Solady `LibZip.flzDecompress` (the on-chain decompressor the `AbxChunkStore` reader uses).
 *
 * We encode off-chain (cheaper than compressing on-chain) and the reader decompresses on
 * read, so a FastLZ chunk stays fully on-chain-renderable — the compression is purely a
 * storage-gas optimization, invisible above the reader. The token never sees FastLZ; it's
 * an internal codec of the chunk store.
 *
 * Token format (what flzDecompress expects):
 *  - literal run: control byte `c` (top 3 bits 0, so `c` in 0..31) ⇒ `c+1` literal bytes follow.
 *  - short match: top 3 bits `t` in 1..6 ⇒ length `t+2` (3..8); distance-1 = `((c&0x1f)<<8)|next`.
 *  - long  match: top 3 bits == 7 ⇒ length `9 + lenByte` (9..264); distance-1 = `((c&0x1f)<<8)|distByte`.
 *  Min match length 3, max back-distance 8192.
 */

const MAX_DISTANCE = 8192;
const MAX_MATCH = 264; // 9 + 255 (one extended-length byte)
const MIN_MATCH = 3;
const MAX_LITERAL_RUN = 32;
const HASH_SIZE = 8192;

function hash3(b: Uint8Array, p: number): number {
  const v = (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
  // 32-bit multiplicative hash → top 13 bits.
  return (Math.imul(v, 0x9e3779b1) >>> 19) & (HASH_SIZE - 1);
}

/** Compress `input` to a FastLZ stream `LibZip.flzDecompress` (and our reader) will inflate. */
export function flzCompress(input: Uint8Array): Uint8Array {
  const n = input.length;
  if (n === 0) return new Uint8Array(0);

  const out: number[] = [];
  const table = new Int32Array(HASH_SIZE).fill(-1);
  let anchor = 0; // first byte of the pending literal run
  let p = 0;

  const emitLiterals = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      const run = Math.min(MAX_LITERAL_RUN, to - i);
      out.push(run - 1); // control byte 0..31
      for (let k = 0; k < run; k++) out.push(input[i + k]);
      i += run;
    }
  };

  while (p + MIN_MATCH <= n) {
    const h = hash3(input, p);
    const ref = table[h];
    table[h] = p;
    const dist = ref >= 0 ? p - ref : 0;

    if (
      ref >= 0 &&
      dist >= 1 &&
      dist <= MAX_DISTANCE &&
      input[ref] === input[p] &&
      input[ref + 1] === input[p + 1] &&
      input[ref + 2] === input[p + 2]
    ) {
      let len = MIN_MATCH;
      const maxLen = Math.min(MAX_MATCH, n - p);
      while (len < maxLen && input[ref + len] === input[p + len]) len++;

      emitLiterals(anchor, p);
      const dm1 = dist - 1;
      if (len <= 8) {
        out.push(((len - 2) << 5) | (dm1 >> 8)); // t = len-2 in 1..6
        out.push(dm1 & 0xff);
      } else {
        out.push((7 << 5) | (dm1 >> 8));
        out.push(len - 9); // 0..255
        out.push(dm1 & 0xff);
      }

      // index the consumed region (better matches downstream), then jump past it.
      const end = p + len;
      let q = p + 1;
      while (q < end && q + MIN_MATCH <= n) {
        table[hash3(input, q)] = q;
        q++;
      }
      p = end;
      anchor = end;
    } else {
      p++;
    }
  }

  emitLiterals(anchor, n); // tail literals (incl. the last <3 bytes that can't start a match)
  return Uint8Array.from(out);
}

/** Inflate a FastLZ stream — the JS mirror of `LibZip.flzDecompress` (for tests + off-chain serve). */
export function flzDecompress(input: Uint8Array): Uint8Array {
  const n = input.length;
  const out: number[] = [];
  let i = 0;
  while (i < n) {
    const c = input[i];
    const t = c >> 5;
    if (t === 0) {
      const count = c + 1; // literal run
      for (let k = 0; k < count; k++) out.push(input[i + 1 + k]);
      i += 2 + c;
    } else {
      const extended = t === 7;
      let len: number;
      let dm1: number;
      if (!extended) {
        len = 2 + t;
        dm1 = ((c & 0x1f) << 8) + input[i + 1];
        i += 2;
      } else {
        len = 9 + input[i + 1];
        dm1 = ((c & 0x1f) << 8) + input[i + 2];
        i += 3;
      }
      const start = out.length - (dm1 + 1);
      for (let k = 0; k < len; k++) out.push(out[start + k]); // overlap-safe (RLE)
    }
  }
  return Uint8Array.from(out);
}
