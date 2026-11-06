/**
 * CLI wrapper around the SDK's newline-aware script splitter. Parses the program (so a SyntaxError
 * cannot ship under a green verify) and encodes chunks for `setScriptChunk`.
 */
import vm from 'node:vm';
import {toHex, type Hex} from 'viem';
import {inlineScriptUnterminatedAt, joinScriptChunks, splitScriptChunks} from '@artblocks/abx-sdk';

/** Warn without changing source or rejecting a write; HTML parsing ignores JS string/comment context. */
export function warnInlineScriptHtml(source: string, at = inlineScriptUnterminatedAt(source)): void {
  if (at === null) return;
  const before = source.slice(0, at).split('\n');
  const line = before.length;
  const column = before[before.length - 1].length + 1;
  // Diagnostics stay on stderr so a structured deployment plan remains readable as JSON.
  console.error(`  ⚠ Inline HTML compatibility (line ${line}, column ${column}): <!-- followed by <script leaves the generated inline script unterminated; the browser never runs the program.`);
  console.error("    In an ordinary string literal, split a token (for example '<!-' + '-'); choose an edit appropriate to its JavaScript context. HTML also sees these sequences inside strings and comments.");
  console.error('    Preview the generated page before uploading or locking. This is a local warning: the source bytes and generator are unchanged.');
}

/**
 * Plan the on-chain script chunks for a template-mode deploy. The generator joins with `'\n'`;
 * {@link splitScriptChunks} splits so that join is byte-identical to `source`. A program that does
 * not parse — before OR after that join — is refused here, because `abx verify` does not parse it.
 */
export function planOnChainScript(source: string, chunkSize?: number): Hex[] {
  assertScriptParses(source, 'the script on disk');
  const parts = chunkSize === undefined ? splitScriptChunks(source) : splitScriptChunks(source, chunkSize);
  const joined = joinScriptChunks(parts);
  if (joined !== source) {
    throw new Error(
      'internal: script chunks do not reassemble to the source. The on-chain generator joins ' +
        'chunks with a newline; this is a toolkit bug, not something to work around.',
    );
  }
  warnInlineScriptHtml(source);
  return parts.map((b) => toHex(b));
}

function assertScriptParses(source: string, what: string): void {
  try {
    // Classic script (not a module). On-chain programs do not `import`; deps ride as <script> tags.
    new vm.Script(source, {filename: 'script.js'});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${what} does not parse as JavaScript (${msg}). The generator joins chunks with a newline — ` +
        'a split mid-token becomes a syntax error on chain, and verify would still go green. ' +
        'Fix the script (or break long lines) before deploying.',
    );
  }
}
