import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {
  contentProjectFromPath,
  isolateProjectContent,
  isProjectContentPath,
  projectContentFrame,
  projectContentPolicy,
  projectContentRequestKind,
  projectContentUrl,
} from '../src/content-origin.js';

const ADDRESS = '0x0123456789012345678901234567890123456789';
const path = `/a/8453/${ADDRESS}/7`;
const policy = projectContentPolicy('https://resolver.test', 'content.test');
const direct = `https://8453-${ADDRESS}.content.test${path}`;

test('collection content addresses preserve paths and token parameters', () => {
  assert.equal(projectContentUrl(policy, `${path}?abx=abc&mode=1#mint`), `${direct}?abx=abc&mode=1#mint`);
  assert.equal(projectContentUrl(policy, `/a/1/${ADDRESS}/7`), `https://1-${ADDRESS}.content.test/a/1/${ADDRESS}/7`);
  assert.deepEqual(contentProjectFromPath(`/t/8453/${ADDRESS.toUpperCase().replace('0X', '0x')}/7`), {chainId: 8453, address: ADDRESS});
});

test('domain configuration rejects URL components, overlapping hosts and invalid DNS labels', () => {
  for (const domain of [
    'https://content.test',
    'content.test/path',
    'content.test?x=1',
    'content.test#x',
    'a@content.test',
    'Content.test',
    'content..test',
    '-content.test',
    'content.test:443',
    'resolver.test',
    'test',
  ]) {
    assert.throws(() => projectContentPolicy('https://resolver.test', domain), undefined, domain);
  }
  assert.throws(() => projectContentPolicy('https://resolver.example.test', 'example.test'));
  assert.equal(projectContentPolicy('http://localhost:8787', 'localhost:8788').contentScheme, 'http:');
});

test('content hosts admit only their own collection read routes', () => {
  assert.equal(projectContentRequestKind(policy, direct), 'content');
  for (const suffix of ['/v1/projects', '/admin-console', '/device', '/oauth/token', '/signup', '/api/projects']) {
    assert.equal(projectContentRequestKind(policy, `https://8453-${ADDRESS}.content.test${suffix}`), 'reject', suffix);
  }
  assert.equal(projectContentRequestKind(policy, direct.replace('/a/8453/', '/a/1/')), 'reject');
  assert.equal(projectContentRequestKind(policy, direct.replace('/7', '/7/extra')), 'reject');
  assert.equal(projectContentRequestKind(policy, `https://nested.8453-${ADDRESS}.content.test${path}`), 'reject');
  assert.equal(projectContentRequestKind(policy, `https://08453-${ADDRESS}.content.test${path}`), 'reject');
  assert.equal(projectContentRequestKind(policy, `https://content.test${path}`), 'reject');
  assert.equal(projectContentRequestKind(policy, 'https://content.test/health'), 'health');
  assert.equal(projectContentRequestKind(policy, `https://resolver.test${path}`), 'public');
  assert.equal(projectContentRequestKind(policy, `https://8453-${ADDRESS}.content.test/abx.js`), 'content');
});

test('all byte-serving surfaces are identified, including collection fields and effects', () => {
  for (const p of [
    path,
    `/t/8453/${ADDRESS}/7/image`,
    `/t/8453/${ADDRESS}/7/data/animation_url`,
    `/t/8453/${ADDRESS}/7/data/render/image`,
    `/c/8453/${ADDRESS}/data/banner_image`,
  ])
    assert.equal(isProjectContentPath(p), true, p);
  for (const p of [`/t/8453/${ADDRESS}/7`, '/device', `/a/08453/${ADDRESS}/7`, `/a/8453/${ADDRESS}/+7`])
    assert.equal(isProjectContentPath(p), false, p);
});

test('public live views contain only a restricted wrapper, with matching script/style hashes', async () => {
  const result = isolateProjectContent(
    policy,
    `https://resolver.test${path}`,
    new Response('<script>projectProgram()</script>', {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}}),
  );
  const html = await result.text();
  assert.equal(result.status, 200);
  assert.ok(!html.includes('projectProgram'));
  assert.ok(html.includes(`<iframe src="${direct}"`));
  assert.equal(result.headers.get('link'), `<${direct}>; rel="canonical"`);
  const csp = result.headers.get('content-security-policy')!;
  for (const tag of ['script', 'style']) {
    const body = new RegExp(`<${tag}>(.*?)</${tag}>`).exec(html)![1];
    assert.ok(csp.includes(`'sha256-${createHash('sha256').update(body).digest('base64')}'`));
  }
  assert.ok(!csp.includes('frame-ancestors'));
  assert.equal(result.headers.get('x-frame-options'), null);
});

test('artifact URLs redirect without substituting a wrapper for committed bytes', async () => {
  for (const p of [`/t/8453/${ADDRESS}/7/data/animation_url`, `/t/8453/${ADDRESS}/7/image`, `/c/8453/${ADDRESS}/data/notes`]) {
    const response = isolateProjectContent(
      policy,
      `https://resolver.test${p}`,
      new Response('exact bytes', {headers: {'content-type': 'text/html'}}),
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), projectContentUrl(policy, p));
  }
});

test('isolated content stays byte-exact, embeddable, and able to use its own origin', async () => {
  const response = isolateProjectContent(
    policy,
    direct,
    new Response('<script>projectProgram()</script>', {headers: {'content-type': 'text/html'}}),
  );
  assert.equal(await response.text(), '<script>projectProgram()</script>');
  assert.equal(response.headers.get('content-security-policy'), null);
  assert.equal(response.headers.get('x-frame-options'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('origin-agent-cluster'), '?1');
});

test('unconfigured and noncanonical content routes have opaque origins, for every MIME type', () => {
  for (const type of [
    'text/html',
    'IMAGE/SVG+XML; charset=utf-8',
    'text/xml',
    'application/xhtml+xml',
    'application/octet-stream',
    'text/javascript',
  ]) {
    for (const [p, url] of [
      [projectContentPolicy('http://localhost:8787'), `http://localhost:8787${path}`],
      [policy, `https://resolver.test/a/8453/${ADDRESS.replace('0x', '%30x')}/7`],
    ] as const) {
      const response = isolateProjectContent(p, url, new Response('bytes', {headers: {'content-type': type}}));
      const csp = response.headers.get('content-security-policy')!;
      assert.match(csp, /sandbox allow-scripts/);
      assert.ok(!csp.includes('allow-same-origin'));
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
  }
});

test('the wrapper escapes URL attributes and never includes caller-supplied HTML', async () => {
  const response = projectContentFrame(`${direct}?x=%22%3E%3Cscript%3E&y=1`);
  assert.match(await response.text(), /&amp;y=1/);
});
