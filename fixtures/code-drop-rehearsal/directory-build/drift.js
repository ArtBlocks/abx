// Drift — the rehearsal artwork. Vanilla canvas, zero dependencies (template mode's
// cleanest case): deterministic from tokenData.seed, colored by the `palette`
// PostParam, reports script-defined traits, signals capture via abx.done().
const td = (window.abx && window.abx.tokenData) || {};
const seedHex = (td.seed || '0x1').slice(2);
const palette = td.palette || '#0e1a40';

// xorshift over the seed words — same seed, same drift, forever
let s0 = parseInt(seedHex.slice(0, 8) || '1', 16) >>> 0;
let s1 = parseInt(seedHex.slice(8, 16) || '9', 16) >>> 0;
function rnd() {
  let x = s0, y = s1;
  s0 = y;
  x ^= x << 23; x >>>= 0;
  s1 = (x ^ y ^ (x >>> 17) ^ (y >>> 26)) >>> 0;
  return ((s1 + y) >>> 0) / 4294967296;
}

const c = document.createElement('canvas');
const size = Math.min(window.innerWidth, window.innerHeight) || 800;
c.width = size; c.height = size;
document.body.appendChild(c);
const ctx = c.getContext('2d');

ctx.fillStyle = palette;
ctx.fillRect(0, 0, size, size);

const lines = 24 + Math.floor(rnd() * 40);
ctx.strokeStyle = 'rgba(255,255,255,0.65)';
ctx.lineWidth = Math.max(1, size / 600);
for (let i = 0; i < lines; i++) {
  const yBase = rnd() * size;
  const amp = rnd() * size * 0.12;
  const freq = 0.002 + rnd() * 0.01;
  const phase = rnd() * Math.PI * 2;
  ctx.beginPath();
  for (let x = 0; x <= size; x += 3) {
    const y = yBase + Math.sin(x * freq + phase) * amp * Math.sin(x / size * Math.PI);
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

window.abx && window.abx.traits && window.abx.traits({
  Palette: palette,
  Density: lines > 48 ? 'Dense' : lines > 32 ? 'Flowing' : 'Sparse',
});
window.abx && window.abx.done && window.abx.done();
