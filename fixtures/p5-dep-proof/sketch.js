// Orbit Weave — p5 dependency-lane proof sketch (template mode, dep p5@1.0.0).
// Deterministic from tokenData.seed; palette (HexColor PostParam) tints the field.
// p5 1.0.0-compatible global mode: no APIs newer than 2020.

var td = (window.abx && abx.tokenData) || {};

function seedInt(hex) {
  var h = (hex || '0x1').replace(/^0x/, '');
  var n = 0;
  for (var i = 0; i < h.length; i++) n = (n * 16 + parseInt(h[i], 16)) % 2147483647;
  return n || 1;
}

var rings, arms, drift;

function setup() {
  createCanvas(windowWidth, windowHeight);
  randomSeed(seedInt(td.seed));
  noiseSeed(seedInt(td.seed) % 65521);
  rings = floor(random(4, 9));
  arms = floor(random(60, 180));
  drift = random(0.2, 1.4);
  noLoop();
}

function draw() {
  var base = color(td.palette || '#0e1a40');
  background(red(base) * 0.25, green(base) * 0.25, blue(base) * 0.25);
  noFill();
  var m = min(width, height);
  translate(width / 2, height / 2);
  for (var r = 1; r <= rings; r++) {
    var rad = (m * 0.42 * r) / rings;
    for (var a = 0; a < arms; a++) {
      var t = (TWO_PI * a) / arms;
      var w = noise(r * 0.7, a * 0.05) * drift;
      stroke(
        red(base) + (255 - red(base)) * (r / rings) * 0.7,
        green(base) + (255 - green(base)) * w * 0.6,
        blue(base) * (0.6 + 0.4 * w),
        140
      );
      strokeWeight(0.5 + w * 2.2);
      arc(0, 0, rad * 2 * (0.92 + w * 0.16), rad * 2 * (0.92 + (1 - w) * 0.16), t, t + TWO_PI / arms * (0.55 + w));
    }
  }
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
