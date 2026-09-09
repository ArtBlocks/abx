/**
 * CLI wrapper around the SDK's newline-aware script splitter. Parses the program (so a SyntaxError
 * cannot ship under a green verify) and encodes chunks for `setScriptChunk`.
 */
import vm from 'node:vm';
import {toHex, type Hex} from 'viem';
import {joinScriptChunks, splitScriptChunks} from '@artblocks/abx-sdk';

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
