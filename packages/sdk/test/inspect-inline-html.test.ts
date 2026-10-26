import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeScript, inlineScriptUnterminatedAt} from '../src/inspect.js';

// Each case: script body → expected offset of the offending `<!--` (null = the inline script ends at
// the shell's own `</script>`).
const CASES: Array<[string, string, number | null]> = [
  ['plain', 'var s="no comment";', null],
  ['comment-open only', 'var s="<!--";', null],
  ['comment then script tag', 'var s="<!--<script>";', 7],
  ['uppercase + space delimiter', "var s='<!--<SCRIPT >';", 7],
  ['escaped close tag does not help', 'var s="<!--<script></script>";', 7],
  ['closed by --> before the tag', 'var s="<!-- --> <script>";', null],
  ['closed by --> after the tag', 'var s="<!--<script>-->";', null],
  ['no tag-name boundary', 'var s="<!--<scripts>";', null],
  ['short form <!--> resets', 'var s="<!--><script>";', null],
  ['inside a JS comment still counts', '// <!-- <script>\nvar x=1;', 3],
  ['offset maps through an earlier escape', 'var a="</script>";var s="<!--<script>";', 25],
  ['author-written <\\/script is not a generator escape', 'var a="<\\/script>"; <!-- <script> x', 20],
  ['author-written and generator escapes mixed', 'var a="<\\/script>";var b="</script>";<!--<script>', 37],
];

for (const [name, src, want] of CASES) {
  test(`inlineScriptUnterminatedAt: ${name}`, () => {
    assert.equal(inlineScriptUnterminatedAt(src), want);
  });
}

test('analyzeScript surfaces inlineHtml', () => {
  assert.deepEqual(analyzeScript('var s="<!--<script>";').inlineHtml, {unterminated: true, at: 7});
  assert.deepEqual(analyzeScript('var s=1;').inlineHtml, {unterminated: false, at: null});
});

test('inlineScriptUnterminatedAt is exported from the SDK entry point', async () => {
  const sdk = await import('../src/index.js');
  assert.equal(sdk.inlineScriptUnterminatedAt, inlineScriptUnterminatedAt);
});
