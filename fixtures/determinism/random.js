// Not a pure function of the seed: colour comes from Math.random, so every view differs.
const c = document.createElement('canvas');
c.width = c.height = 400;
document.body.appendChild(c);
const ctx = c.getContext('2d');
ctx.fillStyle = `hsl(${Math.floor(Math.random() * 360)}, 70%, 50%)`;
ctx.fillRect(0, 0, 400, 400);
abx.traits({mood: 'random'});
abx.done();
