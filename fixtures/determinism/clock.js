// Not a pure function of the seed: a trait and the frame depend on the wall clock.
const c = document.createElement('canvas');
c.width = c.height = 400;
document.body.appendChild(c);
const ctx = c.getContext('2d');
const ms = Date.now() % 1000;
ctx.fillStyle = `rgb(${ms % 256}, 40, 90)`;
ctx.fillRect(0, 0, 400, 400);
abx.traits({ms: String(ms)});
abx.done();
