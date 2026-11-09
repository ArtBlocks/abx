// WebGL drift: same as webgl.js but the colour comes from Math.random, so every view differs.
// Should fail --check. If the browser has no WebGL it draws nothing and still signals done.
const td = (window.abx && window.abx.tokenData) || {};
const seedHex = (td.seed || '0x1').slice(2);
let h = parseInt(seedHex.slice(0, 8) || '1', 16) >>> 0;
const rnd = () => ((h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296);

const c = document.createElement('canvas');
c.width = c.height = 400;
document.body.appendChild(c);
const gl = c.getContext('webgl', {preserveDrawingBuffer: true});
if (gl) {
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}'));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, 'precision mediump float;uniform vec3 u;void main(){gl_FragColor=vec4(u,1.);}'));
  gl.linkProgram(p);
  gl.useProgram(p);
  gl.uniform3f(gl.getUniformLocation(p, 'u'), Math.random(), Math.random(), Math.random());
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([rnd() * 2 - 1, -1, 1, rnd() * 2 - 1, -1, 1]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(p, 'a');
  gl.enableVertexAttribArray(a);
  gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  gl.clearColor(0.05, 0.05, 0.1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
abx.traits({webgl: gl ? 'on' : 'off'});
abx.done();
