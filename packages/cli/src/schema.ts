/**
 * `--schema` spec parsing for `deploy-code` PostParams.
 *
 * The on-chain `setParamSchema(key, paramType, auth, authAddress, lockAfter, min, max, selectOptions)`
 * carries more than the old CLI format (`key:Type:Auth`) could express — a `Select` REQUIRES its
 * option list (the contract reverts `InvalidParamSchema` without it), and the Range types carry
 * `min`/`max` bounds. This parser extends the format with an optional bracket suffix on the Type
 * token so a single, backwards-compatible string expresses all of it:
 *
 *   key:HexColor:TokenOwner                         simple type (unchanged)
 *   key:Select[Spring|Summer|Autumn|Winter]:Auth    Select — options, pipe-delimited (REQUIRED)
 *   key:Uint256Range[0..100]:Auth                    Range — inclusive min..max bounds (optional)
 *   key:Int256Range[-50..50]:Auth
 *   key:DecimalRange[0..1]:Auth                       decimals, ≤10 places (÷1e10 fixed-point)
 *   key:Timestamp[2026-01-01..2026-12-31]:Auth        unix seconds OR ISO dates
 *
 * Delimiters can't collide: params are comma-separated, fields colon-separated, options
 * pipe-separated, bounds `..`-separated — and options/bounds live inside `[...]`, so none of the
 * outer delimiters appear there. Omit the bracket on a Range → unbounded (min=max=0, the prior
 * behavior). A Select with no bracket, or a bracket on a type that takes none, is a clear error.
 */
import {PARAM_TYPES, AUTH_OPTIONS, decodeScalarParam, encodeScalarParam, type ParamTypeName} from '@artblocks/abx-sdk';
import type {Address, Hex} from 'viem';

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

/** The `--schema` type/auth/format catalog, shown wherever the CLI nudges `--schema`. Kept accurate
 *  to the on-chain enums (PARAM_TYPES / AUTH_OPTIONS) + the Select-options / Range-bounds format —
 *  the old hint advertised non-existent `Anyone`/`Admin` auth legs. Used by both `deploy-code`
 *  (commands/deploy.ts) and `inspect` (commands/reads.ts), so it lives here beside the rest of the
 *  `--schema` machinery rather than in either command module. */
export const SCHEMA_CATALOG =
  'Types: Bool·Select·Uint256Range·Int256Range·DecimalRange·HexColor·Timestamp·String·Bytes; ' +
  'Auth: Creator·TokenOwner·Address (or the Or-combos, e.g. CreatorOrTokenOwner). ' +
  "Select needs options — quote the whole spec: 'key:Select[A|B|C]:Auth'; a Range takes bounds — 'key:Uint256Range[0..100]:Auth'. " +
  'A palette collectors set = palette:HexColor:TokenOwner';

/** The types that accept a `[min..max]` bound (the contract's min/max fields are meaningful here). */
const BOUNDED_TYPES = new Set<string>(['Uint256Range', 'Int256Range', 'DecimalRange', 'Timestamp']);

export interface ParsedSchema {
  key: string;
  paramType: number; // index into PARAM_TYPES
  auth: number; // index into AUTH_OPTIONS
  /** Required by (and only valid for) an Address-bearing auth leg; the contract pairs them strictly. */
  authAddress: Address;
  /** Unix seconds after which the VALUE can no longer change. 0 = never locks. A timestamp in the
   *  past locks it immediately and permanently — that is the supported way to retire a parameter. */
  lockAfter: number;
  min: Hex; // bytes32
  max: Hex; // bytes32
  selectOptions: string[];
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;

/**
 * A point in time for `lock=`: unix seconds, an ISO date, or `now` (which means "immediately and
 * forever" — the retire idiom). Reuses the Timestamp encoder so `lock=2026-12-31` parses exactly
 * like a `Timestamp[..]` bound does; one date grammar for the whole flag.
 */
export function parseWhen(raw: string): number {
  const t = raw.trim();
  if (t === '' ) throw new Error('lock= needs a value (unix seconds, an ISO date, or `now`)');
  // `now` locks on the next block. Anything already past is equally permanent — the contract's test
  // is `block.timestamp > lockAfter`.
  if (t.toLowerCase() === 'now') return Math.floor(Date.now() / 1000) - 1;
  const secs = Number(BigInt(encodeScalarParam('Timestamp', t, []).value));
  if (!Number.isSafeInteger(secs) || secs < 0) throw new Error(`bad time "${raw}"`);
  if (secs > 0xffffffffffff) throw new Error(`"${raw}" exceeds the uint48 lock field`);
  return secs;
}

/** min ≤ max in the type's own ordering (mirrors AbxParamsLib's on-chain check, but earlier + clearer). */
function orderedBounds(typeName: string, min: Hex, max: Hex): boolean {
  if (typeName === 'Int256Range') return BigInt.asIntN(256, BigInt(min)) <= BigInt.asIntN(256, BigInt(max));
  return BigInt(min) <= BigInt(max);
}

export function parseSchemaSpec(spec: string): ParsedSchema {
  const parts = spec.split(':');
  if (parts.length !== 3 && parts.length !== 4) {
    throw new Error(
      `--schema "${spec}" — expected key:Type:Auth (a Select adds options: key:Select[A|B|C]:Auth; a Range adds bounds: key:Uint256Range[0..100]:Auth; add :lock=<when> to freeze the value after a date).`,
    );
  }
  const [key, typeToken, authToken, lockToken] = parts;
  // A 4th field is ONLY ever `lock=…`. Anything else there means a colon leaked out of a label or
  // bound and split the spec wrong — report that as the shape error it is, rather than letting the
  // mangled fragments fail later with a confusing "malformed type".
  if (lockToken !== undefined && !/^lock=/.test(lockToken)) {
    throw new Error(
      `--schema "${spec}" — expected key:Type:Auth (with an optional 4th field, lock=<when>). ` +
        `Got ${parts.length} colon-separated fields: a ':' inside a Select option or a bound splits the spec — use simpler labels.`,
    );
  }
  const m = typeToken.match(/^([A-Za-z0-9]+)(?:\[(.*)\])?$/);
  if (!key || !m) throw new Error(`--schema "${spec}" — malformed type "${typeToken}".`);
  const typeName = m[1];
  const bracket = m[2]; // undefined when there is no [...]
  const paramType = PARAM_TYPES.indexOf(typeName as ParamTypeName);
  // An Address-bearing leg names its holder inline: `Address(0x…)`, `CreatorOrAddress(0x…)`. The
  // contract pairs auth and authAddress strictly (one without the other reverts InvalidParamSchema),
  // so they belong in one token rather than a second flag that could be forgotten.
  const am = authToken.match(/^([A-Za-z]+)(?:\((0x[0-9a-fA-F]{40})\))?$/);
  if (!am) throw new Error(`--schema "${spec}" — malformed auth "${authToken}" (an Address leg looks like Address(0x…)).`);
  const authName = am[1];
  const auth = AUTH_OPTIONS.indexOf(authName as (typeof AUTH_OPTIONS)[number]);
  if (paramType < 0 || auth < 0) {
    throw new Error(`--schema "${spec}" — Type ∈ {${PARAM_TYPES.join('|')}}, Auth ∈ {${AUTH_OPTIONS.join('|')}}.`);
  }
  const wantsAddress = AUTH_OPTIONS[auth].includes('Address');
  const authAddress = (am[2] ?? ZERO_ADDR) as Address;
  if (wantsAddress && authAddress === ZERO_ADDR) {
    throw new Error(
      `--schema "${spec}" — ${authName} names a specific writer, so it needs one: ${key}:${typeToken}:${authName}(0xYourAddress). ` +
        `A CONTRACT may hold this leg — that is how open/multi-party participation is built (a controller applies its own rules and forwards the write).`,
    );
  }
  if (!wantsAddress && am[2]) {
    throw new Error(`--schema "${spec}" — ${authName} takes no address; only an Address-bearing leg does.`);
  }

  let lockAfter = 0;
  if (lockToken !== undefined) {
    const lm = lockToken.match(/^lock=(.*)$/);
    if (!lm) throw new Error(`--schema "${spec}" — the 4th field must be lock=<when> (unix seconds, an ISO date, or "now").`);
    try {
      lockAfter = parseWhen(lm[1]);
    } catch (e) {
      throw new Error(`--schema "${spec}" — ${(e as Error).message}`);
    }
  }

  let min = ZERO32;
  let max = ZERO32;
  let selectOptions: string[] = [];

  if (typeName === 'Select') {
    if (bracket === undefined) {
      throw new Error(`--schema "${spec}" — a Select needs its options: '${key}:Select[Option A|Option B|Option C]:${authName}' (quote the whole value in the shell).`);
    }
    selectOptions = bracket.split('|').map((o) => o.trim());
    if (selectOptions.length === 0 || selectOptions.some((o) => o === '')) {
      throw new Error(`--schema "${spec}" — Select options must be non-empty, e.g. '${key}:Select[A|B|C]:${authName}'.`);
    }
    if (new Set(selectOptions).size !== selectOptions.length) {
      throw new Error(`--schema "${spec}" — duplicate Select option in [${selectOptions.join('|')}].`);
    }
    for (const o of selectOptions) {
      if (/[,:\]]/.test(o)) throw new Error(`--schema "${spec}" — a Select option can't contain , : or ] (got "${o}"). Use simpler labels.`);
    }
  } else if (bracket !== undefined) {
    if (!BOUNDED_TYPES.has(typeName)) {
      throw new Error(`--schema "${spec}" — ${typeName} takes no [...]; only ${[...BOUNDED_TYPES].join('/')} take [min..max], and Select takes [options].`);
    }
    const mm = bracket.split('..');
    if (mm.length !== 2) throw new Error(`--schema "${spec}" — bounds are [min..max], e.g. '${key}:${typeName}[0..100]:${authName}'.`);
    try {
      min = encodeScalarParam(typeName as ParamTypeName, mm[0].trim(), []).value;
      max = encodeScalarParam(typeName as ParamTypeName, mm[1].trim(), []).value;
    } catch (e) {
      throw new Error(`--schema "${spec}" — bad bound: ${(e as Error).message}`);
    }
    if (!orderedBounds(typeName, min, max)) {
      throw new Error(`--schema "${spec}" — min must be ≤ max (got ${mm[0].trim()}..${mm[1].trim()}).`);
    }
  }

  return {key, paramType, auth, authAddress, lockAfter, min, max, selectOptions};
}

/** Parse a full `--schema` value: comma-separated specs. */
export function parseSchemaSpecs(raw: string | undefined): ParsedSchema[] {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseSchemaSpec);
}

/** The advisory an EDITION deploy needs before it commits to a schema, or `null` when there is
 *  nothing to say. Returned rather than printed so the deploy lane decides where it lands.
 *
 *  Two things are true on an ERC-1155 edition and on nothing else, and a creator setting up their
 *  first collector-configurable drop will not have thought about either:
 *
 *   1. **Params are per id, so every holder of that id shares one value.** `TokenOwner` means ANY
 *      holder, and it is last-writer-wins. A "name your copy" schema does not name a copy — it
 *      renames the work for all 1,000 holders.
 *   2. **A data param has no on-chain size budget.** One holder can store a large valid value under
 *      every declared key and make the shared id's `tokenURI` too expensive for common RPC limits —
 *      for every co-holder, permanently if a `lockAfter` then bites. That is a deliberate protocol
 *      choice (byte accounting on chain would cost every project to police a configuration almost
 *      nobody should use), which makes saying it here the actual mitigation.
 *
 *  Both are fine when intended: a 1-of-1 edition behaves like a 721, and aggregate state (a counter,
 *  a shared mood) is exactly what shared params are good at. */
export function editionSchemaAdvisory(schemas: ParsedSchema[]): string | null {
  const holderWritable = schemas.filter((s) => {
    const auth = AUTH_OPTIONS[s.auth];
    return auth === 'TokenOwner' || auth === 'CreatorOrTokenOwner' || auth === 'TokenOwnerOrAddress'
      || auth === 'CreatorOrTokenOwnerOrAddress';
  });
  if (holderWritable.length === 0) return null;

  const keys = holderWritable.map((s) => s.key).join(', ');
  const data = holderWritable.filter((s) => {
    const t = PARAM_TYPES[s.paramType];
    return t === 'String' || t === 'Bytes';
  });
  const sizeNote = data.length
    ? ` ${data.map((s) => s.key).join(', ')} ${data.length === 1 ? 'is' : 'are'} a DATA type with no on-chain size cap, so one holder can also make this id's metadata too large for many RPCs to read — for everyone, and permanently if you later lock it.`
    : '';
  // `seed` is the sharpest case of the shared-state rule and worth calling out by name: it is normally
  // settled-once and immutable, but a holder-writable `seed` schema re-opens it — so any holder of the
  // id can re-roll the GENERATIVE seed, changing the rendered artwork for every co-holder of the work.
  // "Each collector picks their own seed" is a 721 idea; on an edition it is "any holder re-rolls
  // everyone's". Almost never intended; a controller contract on the Address leg is the safe shape.
  const hasSeed = holderWritable.some((s) => s.key === 'seed');
  const seedNote = hasSeed
    ? ' seed is holder-writable here: the generative seed is normally immutable, but this lets ANY holder of the id re-roll it and change the artwork for every co-holder. If you want per-collector seeds, that is one id per copy; if you want it governed, put a controller contract on an Address leg.'
    : '';
  return `holder-writable on an edition: ${keys} — params belong to the ID, so every holder of that id shares one value and the last writer wins. If you meant "each collector configures their own", that needs one id per copy.${sizeNote}${seedNote}`;
}

/** A human one-line rendering of a parsed schema (for the confirm readout). */
export function describeSchema(s: ParsedSchema): string {
  const type = PARAM_TYPES[s.paramType];
  const auth = AUTH_OPTIONS[s.auth];
  let detail = '';
  if (type === 'Select') detail = `[${s.selectOptions.join(' | ')}]`;
  else if (s.min !== ZERO32 || s.max !== ZERO32) {
    const lo = decodeScalarParam(type, s.min);
    const hi = decodeScalarParam(type, s.max);
    detail = `[${lo}..${hi}]`;
  }
  const who = s.authAddress && s.authAddress !== ZERO_ADDR ? `(${s.authAddress})` : '';
  const lock = s.lockAfter ? `:lock=${new Date(s.lockAfter * 1000).toISOString().slice(0, 19)}Z` : '';
  return `${s.key}:${type}${detail}:${auth}${who}${lock}`;
}
