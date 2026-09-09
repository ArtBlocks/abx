/**
 * `abx inspect <script.js>` — static analysis of a generative script, BEFORE picking a lane.
 *
 * The membrane fix behind this: an agent (or creator) should DERIVE the deployment lane from what
 * the script actually needs — are there traits? are they reproducible on-chain? how big is the
 * assembled document (does a single `tokenURI` eth_call even fit)? — instead of guessing "fully
 * on-chain!" and walking it back. This module is the pure analysis; `cmdInspect` formats it.
 *
 * Static only — it never executes the script (that's the resolver/runner's job, and executing
 * untrusted code in the CLI would be a footgun). Everything here is regex/heuristic over the source.
 */

/** Approx bytes a known on-chain dependency adds to the ASSEMBLED document (gzip'd + base64'd, as it
 *  rides in the inline data-URI). Measured from real drops; used only for the RPC-size estimate. */
const KNOWN_DEP_DOC_BYTES: Record<string, number> = {
  'p5@1.0.0': 200_000, // p5 1.0.0 (~623KB raw) rides ~200KB gzip+base64 in the document
};

/** The on-chain runtime the generator always inlines (abx.js + the gunzip bootstrap), base64'd. */
const RUNTIME_DOC_BYTES = 13_000;

/** A single `eth_call` returning `tokenURI` comfortably carries this much document on a default node
 *  (geth's 50M gas cap; memory expansion is ~quadratic). Past it, marketplaces that call `tokenURI`
 *  once may time out — prefer the generator's piecewise getters, directory mode, or a CDN dep. */
const SINGLE_CALL_DOC_CEILING = 1_500_000;

export type TraitFeasibility = 'none' | 'exact-likely' | 'careful' | 'infeasible' | 'unknown';

export interface ScriptAnalysis {
  bytes: number;
  estChunks: number; // ~22KB SSTORE2 chunks
  traits: {present: boolean; keys: string[]};
  paramHints: string[]; // PostParam keys the script READS off tokenData (excl. `seed`) — declare with --schema or they're dropped
  prng: {seeded: boolean; usesBareRandom: boolean; usesMathRandom: boolean; usesNoise: boolean};
  depHints: string[]; // detected library globals (e.g. "p5")
  looksP5: boolean;
  feasibility: {verdict: TraitFeasibility; reason: string};
  doc: {estBytes: number; deps: string[]; fitsSingleCall: boolean; unknownDepSizes: boolean};
  // The abx.js runtime data contract — a program MUST read state via `abx.tokenData` (or the raw
  // `window.abxTokenData` global) and report traits via `abx.traits({…})`. An author writing a fresh
  // sketch commonly invents a near-miss global (`window.tokenData`, `window.tokenTraits`, a bare
  // `tokenData`), which deploys + renders without error but is SILENTLY broken: the seed never
  // arrives (every token identical) and traits are empty. `wrongGlobal` names such a near-miss.
  runtime: {readsTokenData: boolean; reportsTraits: boolean; wrongGlobal: string | null};
}

/**
 * Two views of the source, so a regex heuristic can never fire on prose.
 *
 * Every detector here is a regex over the file, and a comment or a string is not code: a
 * dependency-free sketch whose header reads `// vanilla canvas, no p5` was reported as
 * `libraries: p5` and then RECOMMENDED `--dep p5@<version>` — advice the agent adopts verbatim,
 * which bloats the stored document and can drag a drop onto the wrong chain (on-chain deps need a
 * dependency registry ⇒ Sepolia, not Base Sepolia). One tokenizer pass fixes that whole class.
 *
 * - `code`: comments removed, string/template contents blanked (quotes kept, so syntax survives).
 *   For flags that must reflect real code — library globals, PRNG use, the runtime data contract.
 * - `noComments`: comments removed, strings INTACT. For extractors that read literal content —
 *   trait keys (`'Plant Count':`) and bracket-accessed param keys (`tokenData['collapse.index']`).
 */
function sourceViews(source: string): {code: string; noComments: string} {
  const code: string[] = [];
  const noComments: string[] = [];
  const n = source.length;
  let i = 0;
  const push = (ch: string, inString: boolean) => {
    noComments.push(ch);
    code.push(inString ? ' ' : ch);
  };
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    // Comments — dropped from both views (newlines kept so line-anchored regexes still work).
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') push('\n', false);
        i++;
      }
      i += 2;
      continue;
    }
    // Strings + template literals — kept in `noComments`, blanked in `code`.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      push(quote, false);
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          push(source[i], true);
          i++;
          if (i < n) { push(source[i], true); i++; }
          continue;
        }
        push(source[i] === '\n' ? '\n' : source[i], source[i] !== '\n');
        i++;
      }
      if (i < n) { push(quote, false); i++; }
      continue;
    }
    push(ch, false);
    i++;
  }
  return {code: code.join(''), noComments: noComments.join('')};
}

/**
 * Coordinates the runtime injects into `tokenData` on every render. They are NOT PostParams: they
 * arrive automatically, and `--schema tokenId:…` is advice that must never be followed (a reserved
 * key can't be declared). Excluded from {@link paramKeys} so the "declare EACH or it's dropped"
 * warning only ever names keys a creator can actually declare.
 */
const RESERVED_TOKEN_DATA_KEYS = new Set(['seed', 'tokenId', 'chainId', 'contractAddress']);

/** PostParam keys the script READS from tokenData — the palette-style customization inputs. A deploy
 *  that omits these from `--schema` silently drops them (the render sees `undefined` → its default),
 *  which is exactly how a real session "forgot" the palette it had itself identified. Heuristic (the
 *  script isn't executed): find identifiers aliased to `abx.tokenData`, then their property reads;
 *  plus direct `abx.tokenData.key`, destructuring, and `tokenData['key']`. `seed` is intrinsic, not a
 *  PostParam, so it's excluded. Advisory — over- or under-detection is a hint, never a hard gate. */
function paramKeys(source: string): string[] {
  const keys = new Set<string>();
  const add = (k: string | undefined) => { if (k && !RESERVED_TOKEN_DATA_KEYS.has(k)) keys.add(k); };
  // Identifiers aliased to the token-data object — either `abx.tokenData` (via abx.js) or the raw
  // injected global `window.abxTokenData` (e.g. `var td = (window.abx && abx.tokenData) || {}`).
  const aliases = new Set<string>();
  // The `(?!…\.[A-Za-z_$])` guard: only alias when the RHS is the tokenData OBJECT, not a PROPERTY of
  // it — `const seed = abx.tokenData.seed` aliases `seed` to a scalar, so its method calls
  // (`seed.startsWith(…)`) must NOT be read as params (the false-positive that flagged startsWith/slice).
  const aliasRe = /\b([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*(?:abx\s*\??\s*\.\s*tokenData|window\s*\??\s*\.\s*abxTokenData)(?!\s*\??\s*\.\s*[A-Za-z_$])/g;
  let m: RegExpExecArray | null;
  while ((m = aliasRe.exec(source)) !== null) aliases.add(m[1]);
  for (const a of aliases) {
    // `(?!\s*\()` excludes method CALLS (`td.slice(…)`) — a param read is a bare property, never a call.
    const dotRe = new RegExp(`\\b${a.replace(/[$]/g, '\\$')}\\s*\\??\\s*\\.\\s*([A-Za-z_$][\\w$]*)(?!\\s*\\()`, 'g');
    let d: RegExpExecArray | null;
    while ((d = dotRe.exec(source)) !== null) add(d[1]);
    // …and bracket reads through the same alias. A DOTTED key (`collapse.index`) is only readable
    // as `d['collapse.index']`, and ABX's own output-naming convention is dotted
    // (`effect.render.image`) — so alias+bracket is the documented idiom, not an edge case. Missing
    // it produced a false "declare EACH or it's dropped at render" warning on a correct program.
    const brkRe = new RegExp(`\\b${a.replace(/[$]/g, '\\$')}\\s*\\??\\s*\\[\\s*['"]([^'"]+)['"]\\s*\\]`, 'g');
    while ((d = brkRe.exec(source)) !== null) add(d[1]);
  }
  // Direct `abx.tokenData.key` and `abx.tokenData['key']`.
  const directRe = /abx\s*\??\s*\.\s*tokenData\s*\??\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;
  while ((m = directRe.exec(source)) !== null) add(m[1] ?? m[2]);
  // Destructuring: `const { palette, foo } = abx.tokenData` (or an alias).
  const destrRe = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*[^;\n]*(?:abx\s*\.\s*tokenData|\b(?:tokenData|td)\b)/g;
  while ((m = destrRe.exec(source)) !== null) {
    for (const part of m[1].split(',')) add(part.split(':')[0].trim().replace(/\.\.\./, '') || undefined);
  }
  return [...keys];
}

/** Extract the key names from the first `abx.traits({ ... })` object literal (flat objects only). */
function traitKeys(source: string): string[] {
  const m = source.match(/abx\s*\??\s*\.\s*traits\s*\(\s*\{([^}]*)\}/);
  if (!m) return [];
  const keys: string[] = [];
  // A key sits at the start of the object or right after a comma (so a ternary VALUE like
  // `? 'Sparse' : 'Dense'` — a `:` not preceded by `,`/`{` — is never mistaken for a key). Allow
  // leading whitespace after `^` so the FIRST key (preceded only by the newline after `{`) is caught.
  // A key is EITHER a quoted string (arbitrary content — `'Plant Count'`, a spaced trait_type a
  // marketplace shows) OR a bare identifier; a bare-identifier-only match silently dropped quoted
  // keys, and "believe inspect" then sent authors chasing a phantom missing trait.
  const re = /(?:^\s*|[,{]\s*)(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:/g;
  let k: RegExpExecArray | null;
  while ((k = re.exec(m[1])) !== null) keys.push(k[2] ?? k[3]);
  return [...new Set(keys)];
}

export function analyzeScript(source: string, declaredDeps: string[] = []): ScriptAnalysis {
  const bytes = new TextEncoder().encode(source).length;
  // `code` for flags that must reflect real code, `noComments` for literal-content extraction.
  // Never run a detector against the raw source — a comment mentioning p5 is not a p5 dependency.
  const {code, noComments} = sourceViews(source);
  // Runtime flags must read CODE (strings blanked). Trait-key extraction needs the intact
  // object-literal (`'Plant Count':`), so it runs on `noComments` — but ONLY when a real
  // `abx.traits(` call survives in `code`. A string that *mentions* `abx.traits({foo:1})`
  // used to list `foo` while Runtime said "no abx.traits call" — two sections contradicting
  // each other on a correct program. Gate the extractor on the same view the flag uses.
  const usesMathRandom = /Math\s*\.\s*random\s*\(/.test(code);
  // p5's bare random(...) — a `random(` NOT preceded by `.` or a word char (so not Math.random / obj.random)
  const usesBareRandom = /(^|[^.\w])random\s*\(/.test(code);
  const seeded = /\brandomSeed\s*\(/.test(code);
  const usesNoise = /\bnoise\s*\(/.test(code);
  const looksP5 = /\bcreateCanvas\s*\(|function\s+setup\s*\(|function\s+draw\s*\(|\bp5\b/.test(code);
  // A generator the author wrote themselves — the dominant shape for dependency-free work, and
  // invisible to `seeded` (which only knows p5's `randomSeed(`). Matches the arithmetic fingerprints
  // of the usual suspects: LCG multipliers/moduli, xorshift, and the uint32 coercions they need.
  // Deliberately loose: a false positive costs only the more cautious verdict, a false negative
  // promises on-chain reproducibility that a Solidity port may not actually deliver.
  const handRolledPrng =
    /\bMath\s*\.\s*imul\s*\(|>>>\s*0\b|\^=\s*[A-Za-z_$][\w$]*\s*<<|\b(?:1664525|1013904223|1103515245|2147483647|4294967296|69069|22695477)\b/.test(code);
  const depHints: string[] = [];
  if (looksP5) depHints.push('p5');
  if (/\bTHREE\b/.test(code)) depHints.push('three');
  if (/\bTone\b/.test(code)) depHints.push('tone');

  // The abx.js runtime data contract — does the script read state + report traits the ONE way the
  // toolkit injects/captures them? A near-miss global deploys fine but is silently broken.
  // `\??\s*\.` tolerates optional chaining (`abx?.tokenData`) — a common, correct way to read it.
  const readsTokenData = /abx\s*\??\s*\.\s*tokenData\b/.test(code) || /window\s*\??\s*\.\s*abxTokenData\b/.test(code);
  const reportsTraits = /abx\s*\??\s*\.\s*traits\s*\(/.test(code);
  const keys = reportsTraits ? traitKeys(noComments) : [];
  let wrongGlobal: string | null = null;
  if (!readsTokenData) {
    if (/window\s*\.\s*tokenTraits\b/.test(code)) wrongGlobal = 'window.tokenTraits — traits are reported by CALLING abx.traits({…}), never by writing a global';
    else if (/window\s*\.\s*tokenData\b/.test(code)) wrongGlobal = 'window.tokenData — abx injects window.abxTokenData (read it via abx.tokenData), not window.tokenData';
    else if (/\btokenData\b/.test(code)) wrongGlobal = 'a bare `tokenData` — read abx.tokenData (via abx.js) or the raw window.abxTokenData global';
  }

  // Trait-reproducibility rubric (see site/content/docs/protocol/renderers.mdx).
  let verdict: TraitFeasibility;
  let reason: string;
  if (!reportsTraits) {
    verdict = 'none';
    reason = 'no abx.traits({…}) call → NO marketplace traits on ANY lane. A resolver captures the keys you pass to abx.traits(); it does not invent traits from internal variables or a global. Call abx.traits({…}) in the sketch if you want filterable traits.';
  } else if (usesMathRandom && !seeded) {
    verdict = 'infeasible';
    reason = 'traits derive from Math.random() (unseeded) — non-deterministic, reproducible nowhere. Serve attributes via a resolver, or ship without marketplace traits.';
  } else if (seeded && looksP5) {
    verdict = 'exact-likely';
    reason = 'seeded p5 random() is a documented LCG — integer floor/threshold/select traits port EXACTLY to Solidity. Confirm no trait keys off a raw float value. Wire with --attributes-renderer (see site/content/docs/protocol/renderers.mdx).';
  } else if (seeded) {
    verdict = 'careful';
    reason = "seeded, but the PRNG isn't identified as p5 — reproducible on-chain if you port that generator + the exact call order.";
  } else if (usesBareRandom) {
    verdict = 'unknown';
    reason = 'traits present and random() is used, but no randomSeed() was found — check the output is deterministic before attempting on-chain traits.';
  } else if (handRolledPrng) {
    // `seeded` only recognizes p5's `randomSeed(`, so a hand-written generator used to land in the
    // branch below and be told "no PRNG" — with the STRONGER verdict attached. That is backwards, and
    // it is the common case, not an edge one: the skill's own canonical vanilla example hand-rolls an
    // LCG. Porting a bespoke generator to Solidity means reproducing its arithmetic AND its exact call
    // order, which is the `careful` bar, not the field-renderer-and-done bar.
    verdict = 'careful';
    reason =
      'traits derive from a HAND-WRITTEN PRNG seeded off the token seed — deterministic, so reproducible on-chain, ' +
      'but only if you port that exact generator (same arithmetic, same call order) into Solidity. Verify with identical ' +
      'seeds on both sides before committing to on-chain traits; the off-chain resolver lane needs no port.';
  } else {
    verdict = 'exact-likely';
    reason = 'traits look derived from the seed/params directly (no PRNG) — reproducible on-chain via an attributes field-renderer.';
  }

  const deps = declaredDeps;
  let unknownDepSizes = false;
  let depDocBytes = 0;
  for (const d of deps) {
    if (d in KNOWN_DEP_DOC_BYTES) depDocBytes += KNOWN_DEP_DOC_BYTES[d];
    else unknownDepSizes = true;
  }
  const estBytes = bytes + RUNTIME_DOC_BYTES + depDocBytes;
  return {
    bytes,
    estChunks: Math.max(1, Math.ceil(bytes / 22_000)),
    traits: {present: reportsTraits, keys},
    paramHints: paramKeys(noComments),
    prng: {seeded, usesBareRandom, usesMathRandom, usesNoise},
    depHints,
    looksP5,
    feasibility: {verdict, reason},
    doc: {estBytes, deps, fitsSingleCall: estBytes <= SINGLE_CALL_DOC_CEILING && !unknownDepSizes, unknownDepSizes},
    runtime: {readsTokenData, reportsTraits, wrongGlobal},
  };
}

/** A one-line lane recommendation derived from the analysis (the decision-tree output). */
export function recommendLane(a: ScriptAnalysis): string {
  const bigDoc = !a.doc.fitsSingleCall && !a.doc.unknownDepSizes;
  if (bigDoc) {
    return 'DIRECTORY mode (--code-dir) or a CDN dependency — the assembled document is too large for a single tokenURI eth_call to be reliable.';
  }
  if (a.feasibility.verdict === 'infeasible') {
    return 'RESOLVER lane (--public-base-url) if marketplace traits matter (a server serves the JS-derived attributes), OR --onchain-uri and accept no marketplace traits (the tokenURI + animation are still fully on-chain).';
  }
  if (a.feasibility.verdict === 'exact-likely' || a.feasibility.verdict === 'none') {
    const dep = a.depHints.length ? ` --dep ${a.depHints[0]}@<version>` : '';
    const docKb = Math.round(a.doc.estBytes / 1000);
    // Owner call (real-world experience): for a generative drop meant to sell, LEAD with the off-chain
    // resolver — maneuverable over time + marketplaces fetch a SMALL tokenURI reliably. Fully-on-chain
    // is the durability-max alternative, but its ~docKb tokenURI (whole doc per call) strains some
    // marketplace/indexer reads. Traits are NOT a free flag on the on-chain lane (deployed renderer).
    const traits = a.traits.present
      ? ` Traits (${a.traits.keys.join(', ')}): the resolver serves them from the render with no Solidity; on the on-chain lane they need a DEPLOYED --attributes-renderer (fork SeedTraitsRenderer.sol) or they're omitted.`
      : ``;
    return (
      `RECOMMENDED for a drop you'll sell — OFF-CHAIN RESOLVER (--public-base-url + an effects runner): maneuverable (metadata/serving can evolve without on-chain surgery) and marketplaces fetch a SMALL tokenURI reliably.${traits}\n` +
      `  ALTERNATIVE — FULLY ON-CHAIN (--onchain-uri${dep} --image-base <bucket>): maximal durability / no server, but the tokenURI carries the whole ~${docKb}KB document per call (some marketplace + indexer reads choke on a doc this big), stills are MANUAL, and later changes are on-chain re-points. Pick it when permanence + zero-infra outweigh maneuverability.`
    );
  }
  return (
    `RECOMMENDED — an OFF-CHAIN RESOLVER (--public-base-url): maneuverable, and it serves traits from the render regardless of the PRNG. --onchain-uri also works for tokenURI + animation, but first verify the script is deterministic (see the feasibility note), and note the large-tokenURI marketplace-read tradeoff; on that lane traits need a DEPLOYED --attributes-renderer or are omitted.`
  );
}
