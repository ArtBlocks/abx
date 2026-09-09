import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeScript, recommendLane} from '../src/inspect.js';

// A seeded p5 sketch with four traits (Rings via floor, Arms/Drift via threshold, Palette from a param).
const P5_SKETCH = `
var td = (window.abx && abx.tokenData) || {};
function seedInt(hex){var h=(hex||'0x1').replace(/^0x/,'');var n=0;for(var i=0;i<h.length;i++)n=(n*16+parseInt(h[i],16))%2147483647;return n||1;}
var rings, arms, drift;
function setup(){
  createCanvas(windowWidth, windowHeight);
  randomSeed(seedInt(td.seed));
  noiseSeed(seedInt(td.seed) % 65521);
  rings = floor(random(4, 9));
  arms = floor(random(60, 180));
  drift = random(0.2, 1.4);
  noLoop();
}
function draw(){
  var w = noise(1, 2) * drift;
  if (window.abx) {
    abx.traits({
      Rings: rings,
      Arms: arms < 100 ? 'Sparse' : 'Dense',
      Drift: drift < 0.8 ? 'Calm' : 'Wild',
      Palette: td.palette || 'Default',
    });
    abx.done();
  }
}
`;

test('analyzeScript: seeded p5 sketch — all four trait keys, p5 detected, exact-likely, fits one call', () => {
  const a = analyzeScript(P5_SKETCH, ['p5@1.0.0']);
  // The FIRST key (Rings) must be caught — the regression that motivated the ^\\s* fix.
  assert.deepEqual(a.traits.keys, ['Rings', 'Arms', 'Drift', 'Palette']);
  assert.equal(a.looksP5, true);
  assert.equal(a.prng.seeded, true);
  assert.equal(a.prng.usesMathRandom, false);
  assert.equal(a.feasibility.verdict, 'exact-likely');
  assert.equal(a.doc.fitsSingleCall, true); // 1.7KB script + runtime + p5 ~200KB ≪ ceiling
  // Owner call: a generative drop RECOMMENDS the off-chain resolver (maneuverable + small tokenURI);
  // fully-on-chain remains the named ALTERNATIVE (durability-max).
  assert.match(recommendLane(a), /RECOMMENDED[^\n]*RESOLVER/i);
  assert.match(recommendLane(a), /ALTERNATIVE[^\n]*FULLY ON-CHAIN/i);
  // A ternary VALUE ('Sparse'/'Dense'/'Calm'/'Wild') must NOT be mistaken for a trait key.
  for (const bogus of ['Sparse', 'Dense', 'Calm', 'Wild']) assert.ok(!a.traits.keys.includes(bogus), `stray key ${bogus}`);
});

test('traitKeys: a quoted/spaced key (a marketplace trait_type) is detected, not silently dropped', () => {
  // Regression: `'Plant Count'` used to be dropped (bare-identifier-only), so inspect under-counted
  // and — per "believe inspect" — sent authors chasing a phantom missing trait.
  const a = analyzeScript(`function draw(){ abx.traits({ Season: s, Density: d, 'Plant Count': n }); }`);
  assert.deepEqual(a.traits.keys, ['Season', 'Density', 'Plant Count']);
  // and the ternary-value guard still holds (a quoted VALUE after `?`/`:` is not a key)
  const b = analyzeScript(`function draw(){ abx.traits({ Mood: x < 5 ? 'Calm' : 'Wild' }); }`);
  assert.deepEqual(b.traits.keys, ['Mood']);
});

test('analyzeScript: detects PostParams the script reads off tokenData, excludes seed', () => {
  const a = analyzeScript(P5_SKETCH, ['p5@1.0.0']);
  // The sketch reads td.palette (a collector input) and td.seed (intrinsic). palette must surface as
  // a PostParam hint; seed must NOT (it isn't a schema param). This is the silently-dropped-palette fix.
  assert.ok(a.paramHints.includes('palette'), `expected palette in ${JSON.stringify(a.paramHints)}`);
  assert.ok(!a.paramHints.includes('seed'), `seed must be excluded: ${JSON.stringify(a.paramHints)}`);
});

test('analyzeScript: a scalar read from a property (const seed = abx.tokenData.seed) is NOT a tokenData alias — its method calls are not params', () => {
  // Regression: `const seed = abx.tokenData.seed` then `seed.startsWith('0x')` / `seed.slice(2)`
  // used to report bogus params `startsWith`, `slice` (seed was mis-aliased to the tokenData object).
  const a = analyzeScript(`function draw(){ const seed = abx.tokenData.seed || '0x0'; if (seed.startsWith('0x')) return parseInt(seed.slice(2,10),16); }`);
  assert.deepEqual(a.paramHints, []);
  // a real object alias with a bare property read still works, but a method call on it is not a param
  const b = analyzeScript(`function draw(){ var td = (window.abx && abx.tokenData) || {}; var c = td.palette; var s = td.seed.slice(2); return td.toString(); }`);
  assert.ok(b.paramHints.includes('palette'), `expected palette in ${JSON.stringify(b.paramHints)}`);
  assert.ok(!b.paramHints.includes('toString') && !b.paramHints.includes('slice'), `no method-call params: ${JSON.stringify(b.paramHints)}`);
});

test('analyzeScript: no tokenData param reads → no paramHints', () => {
  const a = analyzeScript(`function setup(){createCanvas(400,400);} function draw(){background(0);}`, ['p5@1.0.0']);
  assert.deepEqual(a.paramHints, []);
});

test('analyzeScript: Math.random traits → infeasible on-chain → resolver lane', () => {
  const a = analyzeScript(`function draw(){abx.traits({Roll: Math.random() < 0.5 ? 'H' : 'T'});}`);
  assert.equal(a.prng.usesMathRandom, true);
  assert.equal(a.prng.seeded, false);
  assert.equal(a.feasibility.verdict, 'infeasible');
  assert.match(recommendLane(a), /RESOLVER/);
});

test('analyzeScript: no traits reported → none, still fully-on-chain viable', () => {
  const a = analyzeScript(`function setup(){createCanvas(400,400);} function draw(){background(0);}`, ['p5@1.0.0']);
  assert.equal(a.traits.present, false);
  assert.equal(a.feasibility.verdict, 'none');
  assert.match(recommendLane(a), /RECOMMENDED[^\n]*RESOLVER/i); // resolver-first even with no traits
  assert.match(recommendLane(a), /FULLY ON-CHAIN/); // still named as the durability alternative
});

test('analyzeScript: a document too large for one eth_call → directory-mode recommendation', () => {
  const big = 'x'.repeat(1_600_000); // > the single-call ceiling, no deps → known size
  const a = analyzeScript(`/*${big}*/ function draw(){}`);
  assert.equal(a.doc.fitsSingleCall, false);
  assert.match(recommendLane(a), /DIRECTORY/);
});

// Runtime data contract — the authoring-membrane lint. A fresh sketch that invents its own global
// deploys + renders but never receives the seed/params; these lock in that inspect flags it.
test('runtime contract: the canonical `(window.abx && abx.tokenData)` accessor reads state + reports traits', () => {
  const a = analyzeScript(P5_SKETCH, ['p5@1.0.0']);
  assert.equal(a.runtime.readsTokenData, true);
  assert.equal(a.runtime.reportsTraits, true);
  assert.equal(a.runtime.wrongGlobal, null);
});

test('runtime contract: optional chaining `window.abx?.tokenData` is recognized (not a false near-miss)', () => {
  const a = analyzeScript(`const td = window.abx?.tokenData || {}; const s = td.seed; abx?.traits({A: 1});`);
  assert.equal(a.runtime.readsTokenData, true);
  assert.equal(a.runtime.reportsTraits, true);
  assert.equal(a.runtime.wrongGlobal, null);
});

test('runtime contract: the raw injected global `window.abxTokenData` is recognized', () => {
  const a = analyzeScript(`var td = window.abxTokenData || {}; var s = td.seed;`);
  assert.equal(a.runtime.readsTokenData, true);
});

test('runtime contract: `window.tokenData` near-miss → flagged (seed would never inject)', () => {
  const a = analyzeScript(`var td = window.tokenData || {}; var s = td.seed;`);
  assert.equal(a.runtime.readsTokenData, false);
  assert.match(a.runtime.wrongGlobal ?? '', /window\.tokenData/);
});

test('runtime contract: `window.tokenTraits` near-miss → flagged (traits must be abx.traits())', () => {
  const a = analyzeScript(`window.tokenTraits = {A: 1}; function draw(){}`);
  assert.equal(a.runtime.readsTokenData, false);
  assert.match(a.runtime.wrongGlobal ?? '', /tokenTraits/);
});

test('runtime contract: a bare `tokenData` global → flagged', () => {
  const a = analyzeScript(`var s = tokenData.seed; function draw(){}`);
  assert.equal(a.runtime.readsTokenData, false);
  assert.match(a.runtime.wrongGlobal ?? '', /bare/);
});

test('analyzeScript: no abx.traits() → traits feasibility reason states no traits on ANY lane (not just on-chain)', () => {
  const a = analyzeScript(`function setup(){createCanvas(400,400);} function draw(){background(0);}`, ['p5@1.0.0']);
  assert.match(a.feasibility.reason, /ANY lane/i);
  assert.match(a.feasibility.reason, /does not invent traits/i);
});

// ── heuristics must read CODE, not prose ─────────────────────────────────────────
// Every detector here is a regex over the file. Three ways that misfired on real, correct programs;
// each cost an agent a diagnostic cycle, and the p5 one propagated into a `--dep p5@…` recommendation
// the skill tells agents to adopt verbatim (bloating the document, and pushing on-chain deps to a
// chain whose dependency registry may not exist).

test('inspect: a comment mentioning p5 is NOT a p5 dependency', () => {
  const a = analyzeScript(`
// Dependency-free vanilla canvas. Zero p5, no libraries at all.
const ctx = document.createElement('canvas').getContext('2d');
const seed = abx.tokenData.seed;
abx.traits({ tone: 'flat' });
`);
  assert.deepEqual(a.depHints, []);
});

test('inspect: a string mentioning THREE/Tone is NOT a dependency', () => {
  const a = analyzeScript(`
const note = "not built with THREE, and no Tone either";
const seed = abx.tokenData.seed;
abx.traits({ note: 'x' });
`);
  assert.deepEqual(a.depHints, []);
});

test('inspect: real p5 usage is still detected (the fix must not blind the detector)', () => {
  const a = analyzeScript(`function setup(){createCanvas(400,400);} function draw(){background(0);}`);
  assert.deepEqual(a.depHints, ['p5']);
});

test('inspect: reserved coordinates are never reported as PostParams', () => {
  // `--schema tokenId:…` is advice that must NOT be followed — tokenId/chainId/contractAddress/seed
  // are injected by the runtime and cannot be declared.
  const a = analyzeScript(`
const id = abx.tokenData.tokenId;
const chain = abx.tokenData.chainId;
const addr = abx.tokenData.contractAddress;
const seed = abx.tokenData.seed;
const theme = abx.tokenData.theme;
abx.traits({ id });
`);
  assert.deepEqual(a.paramHints, ['theme']);
});

test('inspect: a dotted param key read by bracket THROUGH AN ALIAS is detected', () => {
  // A dotted key can ONLY be read as `d['collapse.index']`, and ABX's own output-naming convention
  // is dotted — so this idiom must not produce a false "declared or it's dropped" warning.
  const a = analyzeScript(`
const d = abx.tokenData;
const idx = d['collapse.index'] ?? 0;
const img = d["effect.render.image"];
const theme = d.theme;
abx.traits({ idx });
`);
  assert.deepEqual(a.paramHints.sort(), ['collapse.index', 'effect.render.image', 'theme']);
});

test('inspect: a trait key inside a quoted string literal survives comment/string handling', () => {
  // The two views exist so blanking strings for library detection never eats a quoted trait key.
  const a = analyzeScript(`
const seed = abx.tokenData.seed;
abx.traits({ 'Plant Count': 3, Palette: 'Newsprint' });
`);
  assert.deepEqual(a.traits.keys.sort(), ['Palette', 'Plant Count']);
});

test('inspect: a hand-written seeded PRNG is not reported as "no PRNG"', () => {
  // `seeded` only recognizes p5's randomSeed(, so a hand-rolled generator used to fall through to
  // the no-PRNG branch and collect the STRONGER verdict. All three sketches written by cold agents
  // The skill's canonical vanilla example exercises this case.
  const a = analyzeScript(`
    var td = (window.abx && abx.tokenData) || {};
    var z = 0; for (var i = 2; i < td.seed.length; i++) z = (z * 16 + parseInt(td.seed[i], 16)) % 4294967296;
    function rnd(){ z = (1664525 * z + 1013904223) % 4294967296; return z / 4294967296; }
    var rings = 3 + Math.floor(rnd() * 6);
    abx.traits({ Rings: rings });
  `);
  assert.equal(a.feasibility.verdict, 'careful');
  assert.match(a.feasibility.reason, /HAND-WRITTEN PRNG/);
  assert.doesNotMatch(a.feasibility.reason, /no PRNG/);
});

test('inspect: an xorshift generator is caught too', () => {
  const a = analyzeScript(`
    var s = parseInt(abx.tokenData.seed.slice(2, 10), 16) >>> 0;
    function r(){ s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }
    abx.traits({ v: Math.floor(r() * 10) });
  `);
  assert.equal(a.feasibility.verdict, 'careful');
});

test('inspect: traits taken straight off seed/params keep the strong verdict (no false positive)', () => {
  const a = analyzeScript(`
    var td = abx.tokenData;
    abx.traits({ Palette: td.palette, Owner: td.tokenId });
  `);
  assert.equal(a.feasibility.verdict, 'exact-likely');
  assert.match(a.feasibility.reason, /no PRNG/);
});

test('inspect: real seeded p5 still gets the p5-specific verdict', () => {
  const a = analyzeScript(`
    function setup(){ createCanvas(400,400); randomSeed(123); }
    function draw(){ abx.traits({ n: floor(random(1,9)) }); }
  `);
  assert.equal(a.feasibility.verdict, 'exact-likely');
  assert.match(a.feasibility.reason, /p5 random/);
});

// ── Runtime vs Traits must not contradict ──────────────────────────────────────
test('inspect: abx.traits mentioned only in a string is NOT a traits call', () => {
  const a = analyzeScript(`
const note = "abx.traits({foo: 1}) is documentation";
const seed = abx.tokenData.seed;
`);
  assert.equal(a.runtime.reportsTraits, false);
  assert.deepEqual(a.traits.keys, []);
  assert.equal(a.traits.present, false);
  assert.equal(a.feasibility.verdict, 'none');
});

test('inspect: terser sequence-expression traits call is detected', () => {
  const a = analyzeScript(`window.abx&&(abx.traits({Rings:r,Palette:p}),abx.done())`);
  assert.equal(a.runtime.reportsTraits, true);
  assert.deepEqual(a.traits.keys.sort(), ['Palette', 'Rings']);
});

test('inspect: tokenData accessor near the end of a large file is still detected', () => {
  const pad = 'var x = 1;\n'.repeat(2500); // ~30 kB of real code, not comments
  const a = analyzeScript(`${pad}const td = abx.tokenData;\nconst seed = td.seed;\nabx.traits({ Tone: 'flat' });\n`);
  assert.equal(a.runtime.readsTokenData, true);
  assert.equal(a.runtime.reportsTraits, true);
  assert.deepEqual(a.traits.keys, ['Tone']);
});
