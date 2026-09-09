/**
 * OpenSea-style token traits (`attributes`). The protocol stores them as one
 * metadata field (`attributes`) carrying **inline JSON** when on-chain; off-chain,
 * an operator keeps the same array in their resolver's registration. Either way the
 * shape is the marketplace standard — `{trait_type, value, display_type?}` — and
 * NOT a dumping ground for protocol facts (version, canonical, royalty); those are
 * `abx_provenance` / ERC-2981 concerns, never traits. This module is the one place
 * the toolkit parses, validates, and merges them, so the CLI (write side) and the
 * resolver (read side) agree on exactly one normal form.
 */

export interface OpenSeaAttribute {
  trait_type: string;
  value: string | number;
  /** OpenSea display hint, e.g. `number`, `boost_percentage`, `date`. Omitted for plain string traits. */
  display_type?: string;
}

/** Coerce a loose value to a trait value: numbers stay numbers, everything else is a trimmed string. */
function coerceValue(v: unknown): string | number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v).trim();
}

/**
 * Normalize arbitrary input into a validated OpenSea attribute array. Accepts either
 * the canonical array form (`[{trait_type, value, display_type?}]`) or a convenience
 * object map (`{Background: "Blue", Edition: 3}`). Drops entries with an empty
 * `trait_type`. Throws only on a value that's structurally not traits at all.
 */
export function normalizeAttributes(input: unknown): OpenSeaAttribute[] {
  if (input == null) return [];
  const rows: OpenSeaAttribute[] = [];
  if (Array.isArray(input)) {
    for (const raw of input) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const trait_type = String(r.trait_type ?? r.traitType ?? '').trim();
      if (!trait_type) continue;
      const attr: OpenSeaAttribute = {trait_type, value: coerceValue(r.value)};
      const dt = r.display_type ?? r.displayType;
      if (dt != null && String(dt).trim()) attr.display_type = String(dt).trim();
      rows.push(attr);
    }
    return rows;
  }
  if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const trait_type = k.trim();
      if (!trait_type) continue;
      rows.push({trait_type, value: coerceValue(v)});
    }
    return rows;
  }
  throw new Error('attributes must be a JSON array of {trait_type, value} or an object map of {name: value}');
}

/**
 * Parse the quick inline trait form used on the CLI: `"Background=Blue; Edition=3"`.
 * Semicolon- (or newline-) separated `key=value` pairs; a numeric value becomes a
 * number. For anything richer (display_type, etc.) use a JSON file via
 * {@link normalizeAttributes}.
 */
export function parseTraitPairs(spec: string): OpenSeaAttribute[] {
  const out: OpenSeaAttribute[] = [];
  for (const part of spec.split(/[;\n]+/)) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq === -1) throw new Error(`trait "${s}" must be key=value`);
    const trait_type = s.slice(0, eq).trim();
    const rawValue = s.slice(eq + 1).trim();
    if (!trait_type) throw new Error(`trait "${s}" has an empty name`);
    const num = Number(rawValue);
    out.push({trait_type, value: rawValue !== '' && Number.isFinite(num) ? num : rawValue});
  }
  return out;
}

/**
 * Merge on-chain and off-chain attributes into the served set. **On-chain wins per
 * `trait_type`** (case-insensitively) — a trait committed on-chain overrides an
 * off-chain one of the same name — and the rest are unioned. On-chain order is kept
 * first, then any off-chain traits the chain didn't already define.
 */
export function stitchAttributes(
  onChain: OpenSeaAttribute[] | null | undefined,
  offChain: OpenSeaAttribute[] | null | undefined,
): OpenSeaAttribute[] {
  const chain = onChain ?? [];
  const off = offChain ?? [];
  const seen = new Set(chain.map((a) => a.trait_type.toLowerCase()));
  return [...chain, ...off.filter((a) => !seen.has(a.trait_type.toLowerCase()))];
}
