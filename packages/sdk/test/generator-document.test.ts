// These pure unit tests cover the generator-document family shared with `@artblocks/abx-token-api`.
// Token-api's own test/code-serving.test.ts keeps the
// integration coverage that exercises the same functions through the resolver's routes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {escapeInlineJson, escapeInlineScript, injectTokenDataIntoHtml} from '../src/generator-document.ts';

test('escapeInlineScript neutralizes </script> in JS source, any case, behavior-preserving', () => {
  const src = 'const a = "</script><b>"; const b = `</SCRIPT>`; // </Script> in a comment';
  const out = escapeInlineScript(src);
  assert.ok(!/<\/script/i.test(out), 'no raw </script remains');
  // `\/` === `/` inside JS strings — the escaped source evaluates to the identical value
  assert.equal(eval(out.split(';')[0].replace('const a = ', '')), '</script><b>');
  // untouched source passes through byte-identical
  const plain = 'if (a < /b/.source.length) { c(); }';
  assert.equal(escapeInlineScript(plain), plain);
});

test('escapeInlineJson is parse-identical and leaves nothing script-closing', () => {
  const json = JSON.stringify({payload: '</script><script>alert(1)</script>', ok: '<!--'});
  const out = escapeInlineJson(json);
  assert.ok(!out.includes('<'), 'every < is escaped');
  assert.deepEqual(JSON.parse(out), JSON.parse(json), 'delivery form parses to the same value');
});

test('directory injection survives tokenData containing </script>', () => {
  const tokenData = JSON.stringify({tokenId: '1', evil: '</script><script>alert(1)</script>'});
  const html = injectTokenDataIntoHtml('<html><head><script src="drift.js"></script></head></html>', tokenData, 'https://gw/ipfs/CID/');
  // the injected global's script element must not be truncated by the payload
  const m = /<script>window\.abxTokenData=(.*?);<\/script>/.exec(html);
  assert.ok(m, 'injected tag intact');
  assert.deepEqual(JSON.parse(m![1]), JSON.parse(tokenData));
  assert.ok(!html.includes('</script><script>alert(1)'), 'raw payload never appears');
});
