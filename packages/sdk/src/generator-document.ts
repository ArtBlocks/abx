/**
 * The generator-document family — the template-mode runtime companion, the inline-safety
 * escapes, and the pure document-shape builders. Every piece here is a pure string operation with no chain
 * access and no Node dependency, so it belongs in the neutral layer a resolver, a CLI preview,
 * and any third-party provider all consume identically — one definition of the runtime surface
 * and the document shape, so none of them can quietly drift from what the others emit.
 */

/**
 * `abx.js` — the runtime companion (the hl-gen.js analog), served at `/abx.js` and
 * inlined into template-mode documents. Convention, not protocol: a directory build
 * includes it; the generator injects the same surface.
 *
 * tokenData resolution order (the durability chain): the injected `window.abxTokenData`
 * global (template mode) → the `?abx=` query param (base64url canonical JSON — the
 * live-view route) → the `?chainId&contract&tokenId` coordinate floor (a build opened
 * bare from a gateway still knows which token it is; full param reads from RPC are the
 * render-node's job, not this shim's).
 */
export const ABX_JS = `(function () {
  var abx = (window.abx = window.abx || {});
  function fromQuery() {
    try {
      var q = new URLSearchParams(location.search);
      var packed = q.get('abx');
      if (packed) {
        var b64 = packed.replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); })));
      }
      // coordinate floor: enough for a deterministic piece opened bare from a gateway
      if (q.get('contract') && q.get('tokenId')) {
        return {
          chainId: Number(q.get('chainId') || 1),
          contractAddress: String(q.get('contract')).toLowerCase(),
          tokenId: String(q.get('tokenId')),
        };
      }
    } catch (e) {}
    return null;
  }
  abx.tokenData = window.abxTokenData || fromQuery();
  abx.__traits = null;
  abx.__done = false;
  /** The script reports its computed traits (script-defined features; captured at render). */
  abx.traits = function (t) {
    abx.__traits = t;
    try { document.dispatchEvent(new CustomEvent('abx:traits', {detail: t})); } catch (e) {}
    return t;
  };
  /** Output-complete — the capture point for the render effect. Optional (timeout fallback). */
  abx.done = function () {
    abx.__done = true;
    try { document.dispatchEvent(new CustomEvent('abx:done')); } catch (e) {}
  };
})();
`;

/**
 * Inline-document safety — the one HTML parsing rule that matters when embedding
 * content inside <script> elements: the parser ends the element at the first
 * `</script`, regardless of JS string/comment context. Two content shapes, two
 * semantics-preserving escapes:
 *
 *  - JS source (libraries, creator scripts): `</script` → `<\/script`. In valid JS the
 *    sequence can only occur inside a string, template, regex, or comment — contexts
 *    where `\/` is identical to `/` — so the transform never changes behavior.
 *  - JSON (the injected `window.abxTokenData`): every `<` → `\u003c`. `<` only occurs
 *    inside JSON strings (never in the syntax), and `\u003c` parses to the same
 *    character — the canonical (hashed) serialization is untouched; only the delivery
 *    form differs.
 */

/** JS source safe to inline inside a <script> element. Case-insensitive because HTML end tags
 *  are; the on-chain generator matches this (see `AbxGenerator._escapedScript`). */
export function escapeInlineScript(src: string): string {
  return src.replace(/<\/(script)/gi, '<\\/$1');
}

/** A JSON payload safe to inline inside a <script> element (parse-identical). */
export function escapeInlineJson(json: string): string {
  return json.replace(/</g, '\\u003c');
}

/**
 * Inject `window.abxTokenData` (and, when the document doesn't already carry one, a
 * `<base href="{code root}/">` so relative asset paths keep riding the gateway) at the
 * very top of `<head>` — before any build script can execute; abx.js resolves the global
 * first. String-level and deliberately robust rather than a full HTML parse: no `<head>`
 * → inject right after `<html …>`; neither → prepend. First `<base>` wins in HTML, so an
 * existing one is never doubled.
 */
export function injectTokenDataIntoHtml(html: string, tokenDataJson: string, codeRoot: string): string {
  const baseTag = /<base[\s/>]/i.test(html) ? '' : `<base href="${codeRoot}">`;
  const injection = `${baseTag}<script>window.abxTokenData=${escapeInlineJson(tokenDataJson)};</script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + injection + html.slice(at);
  }
  const htmlTag = /<html(\s[^>]*)?>/i.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + injection + html.slice(at);
  }
  return injection + html;
}

/**
 * The template-mode document shape, pure — no chain access, so a caller that already has a
 * script + dep tags in hand (the resolver's own chain-fetched assembly; `abx preview`'s offline
 * studio, local-file + CDN-resolved) can build the byte-identical document. Exported for exactly
 * that reason: **one** definition of the shape, so a caller can never quietly drift from what the
 * generator actually serves — the failure mode a hand-maintained duplicate (with a "keep these in
 * sync" comment and nothing enforcing it) invites.
 */
export function buildGeneratorDocument(script: string, tokenDataJson: string, depTags: string[]): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<style>html,body{margin:0;padding:0;overflow:hidden}canvas{display:block}</style>',
    `<script>window.abxTokenData=${escapeInlineJson(tokenDataJson)};</script>`,
    `<script>${ABX_JS}</script>`,
    ...depTags,
    '</head><body>',
    `<script>\n${escapeInlineScript(script)}\n</script>`,
    '</body></html>',
  ].join('\n');
}
