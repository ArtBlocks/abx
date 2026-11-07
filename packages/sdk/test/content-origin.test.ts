import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {
  contentProjectFromPath,
  contentOriginLabel,
  contentRouteDigest,
  contentDigestFromLabel,
  contentRootPath,
  discoveredLiveViewUrl,
  TOKEN_CONTENT_SCHEME,
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
const label = contentOriginLabel({chainId: 8453, address: ADDRESS, tokenId: '7'});
const direct = `https://${label}.content.test/`;

test('token content addresses use root paths and preserve query and fragment', () => {
  assert.equal(projectContentUrl(policy, `${path}?abx=abc&mode=1#mint`), `${direct}?abx=abc&mode=1#mint`);
  assert.equal(
    projectContentUrl(policy, `/a/1/${ADDRESS}/7`),
    `https://${contentOriginLabel({chainId: 1, address: ADDRESS, tokenId: '7'})}.content.test/`,
  );
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

test('token content hosts admit only their own token read routes', () => {
  assert.equal(projectContentRequestKind(policy, direct), 'content');
  for (const suffix of ['/v1/projects', '/admin-console', '/device', '/oauth/token', '/signup', '/api/projects']) {
    assert.equal(projectContentRequestKind(policy, `https://${label}.content.test${suffix}`), 'reject', suffix);
  }
  assert.equal(projectContentRequestKind(policy, `https://${label}.content.test/a/1/${ADDRESS}/7`), 'reject');
  assert.equal(projectContentRequestKind(policy, `https://${label}.content.test${path}/extra`), 'reject');
  assert.equal(projectContentRequestKind(policy, `https://nested.8453-${ADDRESS}.content.test${path}`), 'reject');
  assert.equal(projectContentRequestKind(policy, `https://08453-${ADDRESS}.content.test${path}`), 'reject');
  assert.equal(projectContentRequestKind(policy, `https://content.test${path}`), 'reject');
  assert.equal(projectContentRequestKind(policy, 'https://content.test/health'), 'health');
  assert.equal(projectContentRequestKind(policy, `https://resolver.test${path}`), 'public');
  assert.equal(projectContentRequestKind(policy, `https://${label}.content.test/abx.js`), 'content');
  assert.equal(projectContentRequestKind(policy, `https://${label}.content.test/a/8453/${ADDRESS}/8`), 'reject');
  assert.equal(projectContentRequestKind(policy, `https://8453-${ADDRESS}.content.test${path}`), 'legacy');
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
  assert.equal(result.headers.get('vary'), 'Sec-Fetch-Dest');
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

test('content frames accept only HTTP(S) URLs without credentials', () => {
  const credentialed = new URL('https://content.test/');
  credentialed.username = 'fixture';
  credentialed.password = 'fixture';
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', credentialed.href]) {
    assert.throws(() => projectContentFrame(url));
  }
});

test('top-level browser navigation redirects while iframe navigation keeps the marketplace wrapper', async () => {
  for (const destination of ['document', 'iframe']) {
    const response = isolateProjectContent(
      policy,
      `https://resolver.test${path}?mode=1`,
      new Response('program', {headers: {'content-type': 'text/html'}}),
      destination,
    );
    assert.equal(response.headers.get('vary'), 'Sec-Fetch-Dest');
    assert.equal(response.status, destination === 'document' ? 302 : 200);
    if (destination === 'document') assert.equal(response.headers.get('location'), `${direct}?mode=1`);
    else assert.match(await response.text(), /<iframe /);
  }
});

test('the localhost content root remains a public control-plane alias in local development', () => {
  const local = projectContentPolicy('http://127.0.0.1:8787', 'localhost:8787');
  assert.equal(projectContentRequestKind(local, 'http://localhost:8787/.well-known/abx-service'), 'public');
  assert.equal(projectContentRequestKind(local, 'http://localhost:8787/api/projects'), 'public');
  assert.equal(projectContentRequestKind(local, `http://8453-${ADDRESS}.localhost:8787/api/projects`), 'reject');
  assert.equal(projectContentRequestKind(local, `http://8453-${ADDRESS}.localhost:8787${path}`), 'legacy');
  assert.equal(projectContentRequestKind(local, `http://${label}.localhost:8787/`), 'content');
});

test('full digests remain canonical and fixed length for every uint256 token id', () => {
  const keys = ['0', '7', '10000000', (2n ** 256n - 1n).toString()].map((tokenId) => ({chainId: 8453, address: ADDRESS, tokenId}));
  for (const key of keys) {
    const label = contentOriginLabel(key);
    assert.equal(label.length, 54);
    assert.equal(contentDigestFromLabel(label), contentRouteDigest(key));
    assert.equal(contentRootPath(label, key), `/a/8453/${ADDRESS}/${key.tokenId}`);
  }
  assert.equal(new Set(keys.map(contentOriginLabel)).size, keys.length);
  assert.notEqual(contentOriginLabel(keys[0]), contentOriginLabel({...keys[0], chainId: 1}));
  assert.equal(contentOriginLabel(keys[0]), contentOriginLabel({...keys[0], address: ADDRESS.toUpperCase().replace('0X', '0x')}));
  for (const tokenId of ['-1', '01', '1e7', (2n ** 256n).toString()]) assert.throws(() => contentOriginLabel({...keys[0], tokenId}));
  assert.equal(contentDigestFromLabel(`t-${'a'.repeat(51)}b`), null);
  assert.equal(contentDigestFromLabel(`t-${'a'.repeat(51)}`), null);
  assert.equal(contentRootPath(label, {...keys[0], tokenId: '8'}), null);
});

test('discovery honors provider templates and falls back for unknown future schemes', () => {
  const key = {chainId: 8453, address: ADDRESS, tokenId: '7'};
  assert.equal(
    discoveredLiveViewUrl(
      'https://resolver.test',
      {scheme: TOKEN_CONTENT_SCHEME, liveViewUrlTemplate: 'https://{tokenOrigin}.content.test/'},
      key,
    ),
    direct,
  );
  assert.equal(
    discoveredLiveViewUrl(
      'https://resolver.test',
      {liveViewUrlTemplate: 'https://{chainId}-{address}.content.test/a/{chainId}/{address}/{tokenId}'},
      key,
    ),
    `https://8453-${ADDRESS}.content.test${path}`,
  );
  assert.equal(
    discoveredLiveViewUrl('https://resolver.test', {scheme: 'future', liveViewUrlTemplate: 'https://unsafe.test/'}, key),
    `https://resolver.test${path}`,
  );
});

test('legacy collection hosts never execute token or collection publisher bytes', async () => {
  for (const path of [`/a/8453/${ADDRESS}/7`, `/t/8453/${ADDRESS}/7/data/animation_url`, `/c/8453/${ADDRESS}/data/banner_image`]) {
    const response = isolateProjectContent(
      policy,
      `https://8453-${ADDRESS}.content.test${path}`,
      new Response('publisher', {headers: {'content-type': 'text/html'}}),
    );
    assert.ok(!(await response.text()).includes('publisher'));
    assert.ok(response.status === 302 || response.headers.get('content-security-policy')?.includes("default-src 'none'"));
  }
});


test('token hostname matches the language-independent SHA-256/base32 vector', () => {
  assert.equal(contentRouteDigest({chainId: 8453, address: ADDRESS, tokenId: '7'}), '0x9ca54d7a31812fb2bf5c1f7ac277c5c54003f64ba79c137f2b3f3eaeb956b934');
  assert.equal(label, 't-tssu26rrqex3fp24d55me56fyvaah5slu6obg7zlh47k5okwxe2a');
});


test('malformed provider templates fall back without unbounded placeholder matching', () => {
  const key = {chainId: 8453, address: ADDRESS, tokenId: '7'};
  assert.equal(discoveredLiveViewUrl('https://resolver.test', {liveViewUrlTemplate: '{{|'.repeat(50000)}, key), `https://resolver.test${path}`);
});
