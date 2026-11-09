import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeScript, inlineScriptUnterminatedAt} from '../src/inspect.js';
import {buildGeneratorDocument} from '../src/generator-document.js';
import {parse, type DefaultTreeAdapterMap} from 'parse5';

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

// Independent HTML parser applied to the actual SDK document builder (also used by preview/resolver).
// A regex count of closing tags would miss this bug: the shell's closing tag is present but not active.
function hasAfter(node: DefaultTreeAdapterMap['node']): boolean {
  if ('attrs' in node && node.attrs.some((a) => a.name === 'id' && a.value === 'abx-inline-after')) return true;
  return 'childNodes' in node && node.childNodes.some(hasAfter);
}

const HTML_CASES = [
  ...CASES.map(([, source]) => source),
  'var s="</SCRIPT>";',
  'var s="<!---><script>";',
  'var s="<!--<script/>";',
  'var s="<!--<script\t>";',
  'var s="<!--<script\f>";',
  'var s="<!--<scriptx>";',
  'var s="<!--<script=foo>";',
  'var s="<!--<script>--><script>";',
  'var s="<!--<script>--><!--<script>";',
  'var s="\\x3c!--<script>";',
  'var s="<!-" + "-<script>";',
  '/* <!--\n<script> */',
  '// <!-- <ScRiPt>\r\nvar x=1;',
];
for (const source of HTML_CASES) {
  test(`generated HTML terminates iff detector says so: ${JSON.stringify(source)}`, () => {
    const html = buildGeneratorDocument(source, '{}', []) + '<p id="abx-inline-after">after</p>';
    assert.equal(hasAfter(parse(html)), inlineScriptUnterminatedAt(source) === null);
  });
}

test('a JavaScript-context author correction restores the generated document and preserves the string value', () => {
  const broken = 'var s="<!--<script>";';
  const fixed = 'var s="<!-" + "-<script>";';
  assert.equal(hasAfter(parse(buildGeneratorDocument(broken, '{}', []) + '<p id="abx-inline-after">after</p>')), false);
  assert.equal(hasAfter(parse(buildGeneratorDocument(fixed, '{}', []) + '<p id="abx-inline-after">after</p>')), true);
  assert.equal(inlineScriptUnterminatedAt(fixed), null);
  assert.equal(Function(`${fixed} return s;`)(), '<!--<script>');
});

test('source positions use UTF-16 offsets across Unicode and previously escaped closing tags', () => {
  const source = 'var emoji="🎨"; var a="</SCRIPT>";\nvar s="<!--<script>";';
  assert.equal(inlineScriptUnterminatedAt(source), source.indexOf('<!--'));
});


test('comment terminator exits double-escaped state to data; a later script opener alone cannot re-enter', () => {
  // HTML 13.2.5.29 switches to script data, not escaped, on the `>` in `-->`.
  // Changing that transition to escaped would incorrectly warn on this valid embedded script.
  const source = 'var s="<!--<script>--><script>";';
  assert.equal(inlineScriptUnterminatedAt(source), null);
  assert.equal(hasAfter(parse(buildGeneratorDocument(source, '{}', []) + '<p id="abx-inline-after">after</p>')), true);

  // A fresh comment opener after the terminator DOES allow double-escaped state again.
  const unterminated = 'var s="<!--<script>--><!--<script>";';
  assert.equal(inlineScriptUnterminatedAt(unterminated), unterminated.lastIndexOf('<!--'));
  assert.equal(hasAfter(parse(buildGeneratorDocument(unterminated, '{}', []) + '<p id="abx-inline-after">after</p>')), false);
});
