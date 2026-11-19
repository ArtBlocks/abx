/**
 * `abx inspect <script.js>` — static analysis of a generative script, BEFORE picking a lane.
 *
 * The membrane fix behind this: an agent (or creator) should DERIVE the deployment lane from what
 * the script actually needs — are there traits? are they reproducible on-chain? how big is the
 * assembled document (does a single `tokenURI` eth_call even fit)? — instead of guessing "fully
 * on-chain!" and walking it back. This module is the pure analysis; `cmdInspect` formats it.
 *
 * Static only — it never executes the script (that's the resolver/runner's job, and executing
 * untrusted code in the CLI would be a footgun). JS analysis uses source heuristics; HTML
 * compatibility checks scan raw source without execution.
 */
import {escapeInlineScript} from './generator-document.js';

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
  paramHints: string[]; // Statically visible PostParam keys, excluding runtime coordinates.
  hasDynamicParamReads?: boolean; // A computed key or rest binding could carry other inputs.
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
  // HTML, not JS: a `<!--` followed by `<script` (any case) inside an inline script flips the HTML
  // tokenizer into its "double-escaped" state, where the generator's own closing `</script>` no longer
  // ends the element. The element runs to end-of-file and the browser never executes it — silently, no
  // console error. The `</script` → `<\/script` escape cannot help (it is a different rule). `at` is the
  // zero-based UTF-16 offset of the offending `<!--` in the source, or null when it terminates normally.
  // Optional so code that builds its own ScriptAnalysis keeps compiling; analyzeScript always sets it.
  inlineHtml?: {unterminated: boolean; at: number | null};
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
 * key can't be declared). Excluded from {@link paramReads} so the "declare EACH or it's dropped"
 * warning only ever names keys a creator can actually declare.
 */
const RESERVED_TOKEN_DATA_KEYS = new Set(['seed', 'tokenId', 'chainId', 'contractAddress']);

const JS_IDENTIFIER = '[A-Za-z_$][\\w$]*';
const TOKEN_DATA = '(?:(?:window\\s*\\??\\.\\s*)?abx\\s*\\??\\.\\s*tokenData|window\\s*\\??\\.\\s*abxTokenData)';
const NAME_START = '(?<![\\w$.])';
const NAME_END = '(?![\\w$])';
const RHS_END = '(?=[ \\t]*(?:[,;}]|$|\\r?\\n(?!\\s*(?:[.(\\[?+*/-]|&&|\\|\\|))))';
const TOKEN_DATA_FALLBACK = '(?:\\|\\||\\?\\?)\\s*\\{\\s*\\}';
const GUARDED_TOKEN_DATA = `(?:window\\s*\\.\\s*abx\\s*&&\\s*)?${TOKEN_DATA}`;
const TOKEN_DATA_OBJECT = `(?:${GUARDED_TOKEN_DATA}|\\(\\s*${GUARDED_TOKEN_DATA}(?:\\s*${TOKEN_DATA_FALLBACK})?\\s*\\))(?:\\s*${TOKEN_DATA_FALLBACK})?`;
const LITERAL_KEY = /^(?:'([^'\\]+)'|"([^"\\]+)")/;

/** Recognize direct reads and simple whole-object aliases without treating arbitrary expressions
 * or computed properties as known schema keys. Use the blanked source for positions and the
 * original spelling only when a quoted property is needed. */
function paramReads(code: string, noComments: string): {paramHints: string[]; hasDynamicParamReads: boolean} {
  const keys = new Set<string>();
  let hasDynamicParamReads = false;
  const add = (key: string) => { if (!RESERVED_TOKEN_DATA_KEYS.has(key)) keys.add(key); };

  // Match a complete RHS. In e.g. (abx.tokenData || {}).seed, the binding is a scalar.
  const assignments = new RegExp(`${NAME_START}(${JS_IDENTIFIER})\\s*=(?!=|>)\\s*`, 'g');
  const objectRhs = new RegExp(`^${TOKEN_DATA_OBJECT}${RHS_END}`);
  const aliases = new Set<string>();
  const assigned = new Set<string>();
  for (const match of code.matchAll(assignments)) {
    const name = match[1];
    // Reused names are ambiguous in a source heuristic. Keep their reads out of the named hints.
    if (assigned.has(name)) aliases.delete(name);
    else if (objectRhs.test(code.slice(match.index + match[0].length))) aliases.add(name);
    assigned.add(name);
  }
  const aliasNames = [...aliases].map((name) => name.replaceAll('$', '\\$')).join('|');
  const receivers = aliasNames ? `(?:${TOKEN_DATA}|${aliasNames})` : TOKEN_DATA;
  const access = new RegExp(
    `${NAME_START}${receivers}${NAME_END}\\s*(?:\\??\\.\\s*(${JS_IDENTIFIER})|(?:\\?\\.\\s*)?\\[)`,
    'g',
  );
  for (const match of code.matchAll(access)) {
    const end = match.index + match[0].length;
    if (match[1]) {
      if (!/^\s*(?:\?\.\s*)?\(/.test(code.slice(end))) add(match[1]);
    } else {
      const literal = /^\s*(?:'([^'\\]+)'|"([^"\\]+)")\s*\]/.exec(noComments.slice(end));
      if (literal) add(literal[1] ?? literal[2]);
      else hasDynamicParamReads = true;
    }
  }

  const fromObject = aliasNames ? `(?:${TOKEN_DATA_OBJECT}|(?:${aliasNames})${NAME_END})` : TOKEN_DATA_OBJECT;
  const destructuring = new RegExp(`\\b(?:const|let|var)\\s*\\{([^{}]*)\\}\\s*=\\s*${fromObject}${RHS_END}`, 'g');
  for (const match of code.matchAll(destructuring)) {
    const start = match.index + match[0].indexOf('{') + 1;
    for (const part of noComments.slice(start, start + match[1].length).split(',')) {
      const property = part.trim();
      if (!property) continue;
      const literal = LITERAL_KEY.exec(property);
      const name = /^([A-Za-z_$][\w$]*)\s*(?=[:=]|$)/.exec(property);
      if (literal) add(literal[1] ?? literal[2]);
      else if (name) add(name[1]);
      else hasDynamicParamReads = true;
    }
  }
  return {paramHints: [...keys], hasDynamicParamReads};
}

/** Extract flat object-literal keys from the first `abx.traits(...)` argument.
 *
 * The argument may choose between object literals (`condition ? {A: 1} : {B: 2}`). Treat every
 * branch as a possible reported shape instead of saying the call reports zero traits. This remains
 * deliberately static and shallow: computed keys or objects built elsewhere are reported as
 * dynamic/unknown by the CLI rather than guessed. */
function traitsCallArgumentStart(source: string): number | null {
  const whitespace = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
  const identifier = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
  let from = 0;
  while (from < source.length) {
    const found = source.indexOf('abx', from);
    if (found === -1) return null;
    from = found + 3;
    if (identifier(source[found - 1]) || identifier(source[from])) continue;
    let i = from;
    while (whitespace(source[i])) i++;
    if (source[i] === '?') {
      i++;
      while (whitespace(source[i])) i++;
    }
    if (source[i] !== '.') continue;
    i++;
    while (whitespace(source[i])) i++;
    if (source.slice(i, i + 6) !== 'traits' || identifier(source[i + 6])) continue;
    i += 6;
    while (whitespace(source[i])) i++;
    if (source[i] === '(') return i + 1;
  }
  return null;
}

function traitsArgument(source: string, start: number): string {
  let quote = '';
  let escaped = false;
  let depth = 1;
  let end = source.length;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) { end = i; break; }
  }
  return source.slice(start, end);
}

function traitKeys(argument: string): string[] {
  const keys: string[] = [];
  // A key sits at the start of the object or right after a comma (so a ternary VALUE like
  // `? 'Sparse' : 'Dense'` — a `:` not preceded by `,`/`{` — is never mistaken for a key). Allow
  // leading whitespace after `^` so the FIRST key (preceded only by the newline after `{`) is caught.
  // A key is EITHER a quoted string (arbitrary content — `'Plant Count'`, a spaced trait_type a
  // marketplace shows) OR a bare identifier; a bare-identifier-only match silently dropped quoted
  // keys, and "believe inspect" then sent authors chasing a phantom missing trait.
  const re = /(?:^\s*|[,{]\s*)(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:/g;
  let k: RegExpExecArray | null;
  while ((k = re.exec(argument)) !== null) keys.push(k[2] ?? k[3]);
  return [...new Set(keys)];
}

/** A tag-name boundary per the HTML tokenizer: whitespace, `/`, or `>` must follow `script`. */
function scriptTagAt(s: string, i: number, prefix: '<' | '</'): boolean {
  const end = i + prefix.length + 6;
  if (s.slice(i, i + prefix.length) !== prefix || s.slice(i + prefix.length, end).toLowerCase() !== 'script') return false;
  return /^[\t\n\f\r />]$/.test(s[end] ?? '');
}

/**
 * Does `src`, inlined as the generator inlines it (`</script` escaped, then the shell's own
 * `\n</script>` appended), end at the shell's close tag? A small model of the HTML tokenizer's
 * script-data states (data → escaped on `<!--`, → double-escaped on `<script`, `-->` back to data,
 * `</script` leaves double-escaped / closes from data or escaped). Returns the offset of the `<!--`
 * that leaves the element unterminated, or null. Raw source on purpose: the HTML parser does not
 * know JS strings or comments, so neither may this.
 */
export function inlineScriptUnterminatedAt(src: string): number | null {
  const escaped = escapeInlineScript(src);
  const doc = escaped + '\n</script>';
  const shellClose = escaped.length + 1;
  type State = 'data' | 'escaped' | 'double';
  let state: State = 'data';
  let openedAt = -1; // offset (in `escaped`) of the `<!--` that entered escaped state
  for (let i = 0; i < doc.length; i++) {
    if (state === 'data') {
      if (doc.startsWith('<!--', i)) {
        state = 'escaped';
        openedAt = i;
        i += 3;
      } else if (scriptTagAt(doc, i, '</')) {
        return i === shellClose ? null : i; // unreachable before the shell after escaping; defensive
      }
    } else if (doc[i] === '>' && doc[i - 1] === '-' && doc[i - 2] === '-') {
      // Both escaped-dash-dash and double-escaped-dash-dash return to script data on `>`.
      // In particular, `<!--<script>--><script>` terminates normally: the second opener is data.
      // https://html.spec.whatwg.org/multipage/parsing.html#script-data-double-escaped-dash-dash-state
      state = 'data'; // `-->` (including the `<!-->` / `<!--->` short forms)
    } else if (state === 'escaped') {
      if (scriptTagAt(doc, i, '</')) return i === shellClose ? null : i;
      if (scriptTagAt(doc, i, '<')) state = 'double';
    } else if (scriptTagAt(doc, i, '</')) {
      state = 'escaped';
    }
  }
  // Map the offset in the escaped text back to the source. Only escapes the generator inserted
  // shift it: one `\` per `</script` in `src` before the `<!--`. A `<\/script` the author already
  // wrote is not an inserted escape and must not be counted.
  let inserted = 0;
  for (const m of src.matchAll(/<\/script/gi)) {
    if (m.index + inserted >= openedAt) break;
    inserted++;
  }
  return openedAt - inserted;
}

export function analyzeScript(source: string, declaredDeps: string[] = []): ScriptAnalysis {
  const bytes = new TextEncoder().encode(source).length;
  // `code` for flags that must reflect real code, `noComments` for literal-content extraction.
  // JS heuristics use these views: a comment mentioning p5 is not a p5 dependency.
  // The HTML compatibility check below deliberately reads raw source, including strings/comments.
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
  // `setup` and `draw` are ordinary application names. Treating either as p5 made vanilla Canvas
  // projects inherit a dependency they never used. Require a p5-specific call/constructor instead.
  const looksP5 = /\bcreateCanvas\s*\(|\brandomSeed\s*\(|\bnew\s+p5\s*\(|\bp5\s*\(/.test(code);
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
  const traitsStart = traitsCallArgumentStart(code);
  const reportsTraits = traitsStart !== null;
  const keys = traitsStart === null ? [] : traitKeys(traitsArgument(noComments, traitsStart));
  const traitsUseMathRandom = traitsStart !== null && /Math\s*\.\s*random\s*\(/.test(traitsArgument(code, traitsStart));
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
  } else if (traitsUseMathRandom) {
    verdict = 'infeasible';
    reason = 'the trait expression calls unseeded Math.random(). Use deterministic trait inputs for reproducible attributes.';
  } else if (usesMathRandom) {
    verdict = 'unknown';
    reason = 'the script uses Math.random(). Static inspection cannot tell whether it affects traits. Check repeatability with identical inputs.';
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
      'the script appears to use a HAND-WRITTEN PRNG. Static inspection cannot tell whether it affects traits. ' +
      'If it does, reproduce the arithmetic and call order in the attributes renderer and compare identical inputs.';
  } else {
    verdict = 'exact-likely';
    reason = 'no PRNG recognized. Verify the traits with repeat renders before porting their logic to an attributes renderer.';
  }

  const deps = declaredDeps;
  let unknownDepSizes = false;
  let depDocBytes = 0;
  for (const d of deps) {
    if (d in KNOWN_DEP_DOC_BYTES) depDocBytes += KNOWN_DEP_DOC_BYTES[d];
    else unknownDepSizes = true;
  }
  const estBytes = bytes + RUNTIME_DOC_BYTES + depDocBytes;
  const unterminatedAt = inlineScriptUnterminatedAt(source);
  return {
    bytes,
    estChunks: Math.max(1, Math.ceil(bytes / 22_000)),
    traits: {present: reportsTraits, keys},
    ...paramReads(code, noComments),
    prng: {seeded, usesBareRandom, usesMathRandom, usesNoise},
    depHints,
    looksP5,
    feasibility: {verdict, reason},
    doc: {estBytes, deps, fitsSingleCall: estBytes <= SINGLE_CALL_DOC_CEILING && !unknownDepSizes, unknownDepSizes},
    runtime: {readsTokenData, reportsTraits, wrongGlobal},
    inlineHtml: {unterminated: unterminatedAt !== null, at: unterminatedAt},
  };
}

/** Animation size and marketplace serving have independent requirements. */
export function recommendLane(a: ScriptAnalysis): string {
  const animation = a.doc.fitsSingleCall
    ? 'Animation can use --onchain-uri. Verify the assembled tokenURI with the RPC and consumers you plan to use.'
    : a.doc.unknownDepSizes
      ? 'Animation size is uncertain until dependency sizes are known. Verify tokenURI or use a resolver.'
      : 'Animation may exceed a single tokenURI call. Consider DIRECTORY mode (--code-dir), a CDN dependency, or the generator’s piecewise getters.';
  const traits = a.traits.present
    ? 'A resolver with a render runner can serve the reported JS traits. Chain-rendered traits require --attributes-renderer.'
    : 'The script has no recognized abx.traits() call for the resolver to capture.';
  return `${animation}
  Marketplace stills need an image renderer, a public image URL, or a resolver. ${traits}`;
}
