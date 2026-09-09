/**
 * Per-token marketplace traits for a Series (`deploy-series --attributes <file.json>`).
 *
 * The contract already carries per-token `attributes` fields (`SeriesImage.InitParams.tokenFields`,
 * keyed by tokenId) — exactly like the per-token `image` fields deploy-series already writes. This is
 * purely the CLI ergonomics of supplying them for a folder of media, so it's extracted here (main.ts
 * runs the CLI on import, so its helpers aren't unit-testable). The manifest is EITHER:
 *   • an ARRAY indexed by token id — `[[{trait_type,value}…], …]` (element i = token i); OR
 *   • an OBJECT keyed by the media FILENAME (with or without extension) or the token-id string.
 * Each value is an OpenSea attributes array OR a `{name: value}` map (normalized either way).
 */
import {normalizeAttributes, type OpenSeaAttribute} from '@artblocks/abx-sdk';

/** Parse the `--attributes` manifest CONTENT (not a path) into a sparse tokenId → attributes map. */
export function parseSeriesTraits(rawJson: string | undefined, slots: string[]): Map<number, OpenSeaAttribute[]> {
  const out = new Map<number, OpenSeaAttribute[]>();
  if (!rawJson) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`--attributes: not valid JSON (${(e as Error).message})`);
  }
  const put = (i: number, v: unknown) => {
    if (v == null) return;
    const attrs = normalizeAttributes(v);
    if (attrs.length) out.set(i, attrs);
  };
  if (Array.isArray(parsed)) {
    parsed.forEach((v, i) => { if (i < slots.length) put(i, v); });
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    slots.forEach((name, i) => {
      const base = name.replace(/\.[^.]+$/, '');
      put(i, obj[name] ?? obj[base] ?? obj[String(i)]);
    });
  } else {
    throw new Error('--attributes for a Series expects a JSON array (indexed by token id) or an object keyed by filename / token id — each value an attributes array or a {name: value} map.');
  }
  return out;
}

/**
 * True when a `--attributes` payload is the Series PER-TOKEN shape — an array whose elements are
 * themselves attribute arrays/maps (element i = token i), or an object whose VALUES are attribute
 * arrays/maps (keyed by token id / filename) — as opposed to a flat 1/1 payload (an OpenSea attributes
 * array `[{trait_type,value}…]` or a single `{name: value}` map). Ambiguity defaults to flat, so a
 * 1/1's `--attributes` at `abx add` is never mis-read as per-token. Content, not a path.
 */
export function looksPerTokenAttributes(rawJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return false;
  }
  const isAttr = (v: unknown) => v != null && typeof v === 'object' && !Array.isArray(v) && 'trait_type' in (v as object);
  const isScalar = (v: unknown) => v == null || typeof v !== 'object';
  if (Array.isArray(parsed)) {
    // Flat = array of {trait_type,value}; per-token = array of arrays/maps (no top-level trait_type).
    return parsed.length > 0 && parsed.every((v) => Array.isArray(v) || (v != null && typeof v === 'object' && !isAttr(v)));
  }
  if (parsed && typeof parsed === 'object') {
    const vals = Object.values(parsed as Record<string, unknown>);
    // Flat `{name: value}` map = scalar values; per-token = every value is an array/map of traits.
    return vals.length > 0 && vals.every((v) => !isScalar(v));
  }
  return false;
}

/**
 * Parse a PER-TOKEN `--attributes` payload for an EDIT at `abx add` — no media folder is present, so
 * only token-id keys resolve (an array indexes by token id; an object's numeric keys are token ids;
 * filename-only keys can't be mapped and are dropped). Returns a `{ "<tokenId>": OpenSeaAttribute[] }`
 * map ready for the `tokenAttributes` column. Content, not a path.
 */
export function parseSeriesTraitsById(rawJson: string): Record<string, OpenSeaAttribute[]> {
  const parsed = JSON.parse(rawJson) as unknown;
  const out: Record<string, OpenSeaAttribute[]> = {};
  const put = (id: string, v: unknown) => {
    if (v == null) return;
    const attrs = normalizeAttributes(v);
    if (attrs.length) out[id] = attrs;
  };
  if (Array.isArray(parsed)) {
    parsed.forEach((v, i) => put(String(i), v));
  } else if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (/^\d+$/.test(k)) put(k, v); // token-id keys only — filenames need the deploy's --dir
    }
  }
  return out;
}
