// Deterministic animation: frame 1 is drawn at abx.done(); the piece then moves once, at 500ms,
// from the seed alone. Every run, at every captured frame, renders the same pixels.
const td = (window.abx && window.abx.tokenData) || {};
const seedHex = (td.seed || '0x1').slice(2);
const hue = parseInt(seedHex.slice(0, 4) || '1', 16) % 360;
const c = document.createElement('canvas');
c.width = c.height = 400;
document.body.appendChild(c);
const ctx = c.getContext('2d');
function draw(x) {
  ctx.fillStyle = `hsl(${hue}, 40%, 20%)`;
  ctx.fillRect(0, 0, 400, 400);
  ctx.fillStyle = `hsl(${hue}, 80%, 70%)`;
  ctx.fillRect(x, 150, 100, 100);
}
draw(50);
abx.traits({hue: String(hue)});
abx.done();
setTimeout(() => draw(250), 500);
