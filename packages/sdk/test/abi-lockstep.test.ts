// The four externalized libraries (`AbxParamsLib`, `AbxCodeLib`, `AbxMetadataLib`, `AbxEditionLib`)
// are reached two ways, and both have a lockstep the compiler cannot check:
//
// 1. **Raw-calldata passthroughs.** A token function forwards its own calldata to the library with
//    `delegatecall` and returns the library's returndata untouched (see `Params._delegateParamsRead`
//    and its siblings). The selector only matches if the library function has the same name and
//    input types; the caller only decodes correctly if the OUTPUT types match too. Neither is a
//    type error in Solidity — a drifted input is a revert, and a drifted output is a silent
//    mis-decode in every client.
// 2. **Errors and events raised inside the library.** They log and revert from the token address,
//    so a wallet, explorer or SDK holding the token's verified ABI can only decode them if the
//    token's ABI declares them too.
//
// This test derives the passthrough list from the Solidity source rather than a hand-kept list, so
// a new passthrough is covered without anyone remembering to add it here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';
import {
  abxCodeLibAbi,
  abxEditionLibAbi,
  abxMetadataLibAbi,
  abxParamsLibAbi,
  editionCodeAbi,
  editionImageAbi,
  oneOfOneEditionAbi,
  oneOfOneImageAbi,
  seriesCodeAbi,
  seriesImageAbi,
} from '../src/abi/generated.js';

type Param = {type: string; components?: ReadonlyArray<Param>};
type Fragment = {
  type: string;
  name?: string;
  inputs?: ReadonlyArray<Param>;
  outputs?: ReadonlyArray<Param>;
};
type Abi = ReadonlyArray<Fragment>;

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/src');

/**
 * Canonical ABI type, expanding tuples so two structs with the same name but different fields
 * differ. A library's ABI names an enum by its Solidity type (`IAbxConfigurableParams.ParamType`)
 * where a contract's ABI says `uint8`; both encode as `uint8`, so they compare equal here.
 */
function typeOf(p: Param): string {
  if (p.type.includes('.')) return p.type.replace(/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+/, 'uint8');
  if (!p.type.startsWith('tuple')) return p.type;
  return `(${(p.components ?? []).map(typeOf).join(',')})${p.type.slice('tuple'.length)}`;
}
const sig = (f: Fragment) => `${f.name}(${(f.inputs ?? []).map(typeOf).join(',')})`;
const outs = (f: Fragment) => `(${(f.outputs ?? []).map(typeOf).join(',')})`;

const TOKENS: Record<string, Abi> = {
  OneOfOneImage: oneOfOneImageAbi,
  SeriesImage: seriesImageAbi,
  SeriesCode: seriesCodeAbi,
  OneOfOneEdition: oneOfOneEditionAbi,
  EditionImage: editionImageAbi,
  EditionCode: editionCodeAbi,
};

/** Each raw-calldata helper, and the library its `delegatecall` targets. */
const HELPERS: Record<string, {lib: string; abi: Abi; file: string}> = {
  _delegateParamsRead: {lib: 'AbxParamsLib', abi: abxParamsLibAbi, file: 'libraries/AbxParamsLib.sol'},
  _delegateParamsWrite: {lib: 'AbxParamsLib', abi: abxParamsLibAbi, file: 'libraries/AbxParamsLib.sol'},
  _delegateCodeRead: {lib: 'AbxCodeLib', abi: abxCodeLibAbi, file: 'libraries/AbxCodeLib.sol'},
  _delegateMetadataRead: {
    lib: 'AbxMetadataLib',
    abi: abxMetadataLibAbi,
    file: 'libraries/AbxMetadataLib.sol',
  },
  _delegateEditionUriRead: {
    lib: 'AbxEditionLib',
    abi: abxEditionLibAbi,
    file: 'libraries/AbxEditionLib.sol',
  },
};

/**
 * Public signatures of a library's STATE-CHANGING functions, read from its source. solc leaves those
 * out of a library's ABI (they are only reachable by `delegatecall`), so the generated ABI cannot
 * answer "does the write front door this token forwards to exist". Only value types, `bytes`,
 * `string[]` and enums occur in these signatures; an enum (a qualified name) is `uint8` in the ABI.
 */
function librarySourceSignatures(file: string): Set<string> {
  const code = readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const out = new Set<string>();
  for (const m of code.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)([^{;]*)[{;]/g)) {
    const [, name, params, modifiers] = m;
    if (!/\b(public|external)\b/.test(modifiers)) continue;
    const types = params
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const t = p.split(/\s+/)[0];
        return t.includes('.') ? 'uint8' : t;
      });
    out.add(`${name}(${types.join(',')})`);
  }
  return out;
}

/** Which tokens compose each library — the tokens whose ABI must carry its errors and events. */
const COMPOSERS: Record<string, {abi: Abi; tokens: string[]}> = {
  AbxParamsLib: {abi: abxParamsLibAbi, tokens: ['SeriesCode', 'EditionCode']},
  AbxCodeLib: {abi: abxCodeLibAbi, tokens: ['SeriesCode', 'EditionCode']},
  AbxMetadataLib: {abi: abxMetadataLibAbi, tokens: Object.keys(TOKENS)},
  AbxEditionLib: {
    abi: abxEditionLibAbi,
    tokens: ['OneOfOneEdition', 'EditionImage', 'EditionCode'],
  },
};

function solidityFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return solidityFiles(p);
    return p.endsWith('.sol') ? [p] : [];
  });
}

/** `{function name → helper}` for every non-underscore function whose body calls a helper. */
function passthroughs(): Map<string, string> {
  const found = new Map<string, string>();
  const helperCall = new RegExp(`\\b(${Object.keys(HELPERS).join('|')})\\(\\)\\s*;`);
  for (const file of solidityFiles(SRC)) {
    // Comments mention helpers by name; only code counts.
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const chunk of code.split(/\bfunction\s+/).slice(1)) {
      const name = chunk.match(/^([A-Za-z0-9_]+)\s*\(/)?.[1];
      const helper = chunk.match(helperCall)?.[1];
      if (!name || !helper || name.startsWith('_')) continue;
      found.set(name, helper);
    }
  }
  return found;
}

test('the passthrough scan finds the known surface', () => {
  const found = passthroughs();
  // A floor, not an exact count: it fails if the scan silently stops matching (a renamed helper,
  // a reformatted body), which would otherwise turn every assertion below into a no-op.
  assert.ok(found.size >= 30, `expected at least 30 passthrough functions, found ${found.size}`);
  for (const name of ['configureTokenParam', 'setTokenParam', 'scriptChunk', 'tokenField', 'uri']) {
    assert.ok(found.has(name), `expected ${name} to be detected as a passthrough`);
  }
});

test('every raw-calldata passthrough matches its library function in inputs AND outputs', () => {
  for (const [name, helper] of passthroughs()) {
    const {lib, abi: libAbi, file} = HELPERS[helper];
    let composed = 0;
    for (const [token, tokenAbi] of Object.entries(TOKENS)) {
      for (const tf of tokenAbi.filter((f) => f.type === 'function' && f.name === name)) {
        composed++;
        const lf = libAbi.find((f) => f.type === 'function' && sig(f) === sig(tf));
        if (lf) {
          assert.equal(
            outs(lf),
            outs(tf),
            `${token}.${sig(tf)} returns ${lib}'s returndata verbatim, but declares ${outs(tf)} ` +
              `while ${lib} returns ${outs(lf)}: clients would silently mis-decode the result.`,
          );
          continue;
        }
        // Not in the ABI ⇒ a state-changing front door. It must exist in source, and the token must
        // not promise a return value the library does not produce.
        assert.ok(
          librarySourceSignatures(file).has(sig(tf)),
          `${token}.${sig(tf)} forwards raw calldata to ${lib}, which has no public function with ` +
            'that signature: every call reverts. Keep the library signature byte-identical.',
        );
        assert.equal(
          outs(tf),
          '()',
          `${token}.${sig(tf)} is a write passthrough but declares outputs ${outs(tf)}.`,
        );
      }
    }
    assert.ok(composed > 0, `${name} forwards to ${lib} but no token exposes it`);
  }
});

test('every error and event a library raises is in each composing token ABI', () => {
  for (const [lib, {abi: libAbi, tokens}] of Object.entries(COMPOSERS)) {
    const raised = libAbi.filter((f) => f.type === 'error' || f.type === 'event');
    for (const token of tokens) {
      const have = new Set(
        TOKENS[token].filter((f) => f.type === 'error' || f.type === 'event').map(
          (f) => `${f.type} ${sig(f)}`,
        ),
      );
      const missing = raised.map((f) => `${f.type} ${sig(f)}`).filter((k) => !have.has(k));
      assert.deepEqual(
        missing,
        [],
        `${lib} can raise these from ${token}'s address, but ${token}'s ABI cannot decode them. ` +
          'Declare them on the extension interface the token composes.',
      );
    }
  }
});
