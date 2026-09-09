// resolveRemote — the pure resolution behind `--remote <name|url>` (remote.ts). Everything here
// runs against an explicit env object; nothing reads process.env.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeRemoteError, listConfiguredRemotes, misnamedRemoteVars, requireRemoteToken, resolveRemote, selfTokenMigrationWarning, tokenSourceLabel} from '../src/remote.js';
import {AbxServiceError} from '@artblocks/abx-sdk';

test('undefined --remote means a local op', () => {
  assert.equal(resolveRemote(undefined, undefined, {}), null);
});

test('bare --remote is the self-host default: ABX_PUBLIC_BASE_URL, else ABX_RESOLVER_URL, else a clear error', () => {
  const t = resolveRemote('true', undefined, {ABX_PUBLIC_BASE_URL: 'https://meta.example.xyz/', ABX_REMOTE_SELF_TOKEN: 'tok'});
  assert.deepEqual(t, {url: 'https://meta.example.xyz', token: 'tok', source: 'default', tokenVar: 'ABX_REMOTE_SELF_TOKEN', tokenFrom: 'env'});
  // ownerops' historical extra fallback is preserved in the ONE merged resolver
  const t2 = resolveRemote('true', undefined, {ABX_RESOLVER_URL: 'http://localhost:8787'});
  assert.equal(t2?.url, 'http://localhost:8787');
  assert.equal(t2?.token, undefined);
  assert.throws(() => resolveRemote('true', undefined, {}), /ABX_PUBLIC_BASE_URL/);
});

test('a URL form uses the self-host token conventions and strips trailing slashes', () => {
  const t = resolveRemote('https://node.fly.dev///', undefined, {ABX_REMOTE_SELF_TOKEN: 'tok'});
  assert.deepEqual(t, {url: 'https://node.fly.dev', token: 'tok', source: 'url', tokenVar: 'ABX_REMOTE_SELF_TOKEN', tokenFrom: 'env'});
});

// "self" is not a special case in the code — it is just a name under the SAME ABX_REMOTE_<NAME>_*
// grammar every other remote uses. Addressing your own node by `--remote self` (rather than bare
// `--remote`) resolves through the exact same generic named-remote branch as `--remote prod`.
test('--remote self resolves ABX_REMOTE_SELF_URL/_TOKEN with zero special-casing', () => {
  const env = {ABX_REMOTE_SELF_URL: 'https://my-node.example/', ABX_REMOTE_SELF_TOKEN: 'self-tok'};
  const t = resolveRemote('self', undefined, env);
  assert.deepEqual(t, {url: 'https://my-node.example', token: 'self-tok', name: 'SELF', source: 'named', tokenVar: 'ABX_REMOTE_SELF_TOKEN', tokenFrom: 'env'});
});

test('a NAME resolves ABX_REMOTE_<NAME>_URL/_TOKEN with the ABX_RPC_URLS-style normalization', () => {
  const env = {ABX_REMOTE_MY_PROVIDER_URL: 'https://api.provider.xyz/', ABX_REMOTE_MY_PROVIDER_TOKEN: 'key-1'};
  // hyphens, dots, and case all normalize to the same var
  for (const spec of ['my-provider', 'My.Provider', 'MY_PROVIDER']) {
    const t = resolveRemote(spec, undefined, env);
    assert.deepEqual(t, {url: 'https://api.provider.xyz', token: 'key-1', name: 'MY_PROVIDER', source: 'named', tokenVar: 'ABX_REMOTE_MY_PROVIDER_TOKEN', tokenFrom: 'env'});
  }
});

test('--remote abx is the built-in first-party service and reads only ABX_SERVICES_API_KEY', () => {
  assert.deepEqual(resolveRemote('abx', undefined, {ABX_SERVICES_API_KEY: 'free-key'}), {
    url: 'https://services.abx.io',
    token: 'free-key',
    name: 'ABX',
    source: 'builtin',
    tokenVar: 'ABX_SERVICES_API_KEY',
    tokenFrom: 'env',
  });
  assert.equal(
    resolveRemote('ABX', 'override', {ABX_SERVICES_API_KEY: 'free-key'})?.token,
    'override',
  );
  assert.throws(
    () => requireRemoteToken(resolveRemote('abx', undefined, {})!),
    /abx auth login.*manual fallback.*services\.abx\.io\/signup/s,
  );
});

test('an unset named remote fails naming the EXACT var (and hints the URL form)', () => {
  assert.throws(() => resolveRemote('prod', undefined, {}), /ABX_REMOTE_PROD_URL/);
  assert.throws(() => resolveRemote('localhost:8787', undefined, {}), /--remote https:\/\/host/);
});

test('a named remote NEVER falls back to ABX_REMOTE_SELF_TOKEN (the self-node secret must not leak to a provider)', () => {
  const t = resolveRemote('prod', undefined, {ABX_REMOTE_PROD_URL: 'https://api.provider.xyz', ABX_REMOTE_SELF_TOKEN: 'node-secret'});
  assert.equal(t?.token, undefined);
  assert.throws(() => requireRemoteToken(t!), /ABX_REMOTE_PROD_TOKEN/);
});

test('--remote-token wins over any env token, on every form', () => {
  assert.equal(resolveRemote('true', 'flag-tok', {ABX_PUBLIC_BASE_URL: 'https://x', ABX_REMOTE_SELF_TOKEN: 'env'})?.token, 'flag-tok');
  assert.equal(resolveRemote('https://x', 'flag-tok', {ABX_REMOTE_SELF_TOKEN: 'env'})?.token, 'flag-tok');
  assert.equal(resolveRemote('p', 'flag-tok', {ABX_REMOTE_P_URL: 'https://x', ABX_REMOTE_P_TOKEN: 'env'})?.token, 'flag-tok');
});

test('requireRemoteToken names the right var per source', () => {
  assert.throws(() => requireRemoteToken(resolveRemote('https://x', undefined, {})!), /ABX_REMOTE_SELF_TOKEN/);
  assert.equal(requireRemoteToken(resolveRemote('https://x', undefined, {ABX_REMOTE_SELF_TOKEN: 't'})!), 't');
});

// The old client-side var (ABX_RESOLVER_ADMIN_TOKEN) is no longer read for the self-host default —
// no silent fallback. A creator who hasn't renamed yet gets a pointed error naming BOTH new vars,
// not a generic "set ABX_REMOTE_SELF_TOKEN" that leaves them guessing why their old .env stopped working.
test('the OLD var (ABX_RESOLVER_ADMIN_TOKEN) present with no new var is a pointed error naming both new vars', () => {
  const bareEnv = {ABX_PUBLIC_BASE_URL: 'https://x', ABX_RESOLVER_ADMIN_TOKEN: 'old-secret'};
  assert.throws(
    () => requireRemoteToken(resolveRemote('true', undefined, bareEnv)!, bareEnv),
    /ABX_REMOTE_SELF_TOKEN.*ABX_REMOTE_SELF_URL/s,
  );
  const urlEnv = {ABX_RESOLVER_ADMIN_TOKEN: 'old-secret'};
  assert.throws(
    () => requireRemoteToken(resolveRemote('https://x', undefined, urlEnv)!, urlEnv),
    /ABX_RESOLVER_ADMIN_TOKEN/,
  );
});

test('selfTokenMigrationWarning: null once the new var is set, regardless of the old one lingering', () => {
  assert.equal(selfTokenMigrationWarning({ABX_RESOLVER_ADMIN_TOKEN: 'old', ABX_REMOTE_SELF_TOKEN: 'new'}), null);
  assert.equal(selfTokenMigrationWarning({}), null);
  assert.match(selfTokenMigrationWarning({ABX_RESOLVER_ADMIN_TOKEN: 'old'})!, /ABX_REMOTE_SELF_TOKEN/);
});

test('a near-miss token var name is detected — only _URL/_TOKEN are read, so a typo is otherwise invisible', () => {
  assert.deepEqual(
    misnamedRemoteVars({
      ABX_REMOTE_PROD_URL: 'https://x',
      ABX_REMOTE_PROD_KEY: 'the-key-in-the-wrong-var',
      ABX_REMOTE_STAGE_API_KEY: 'k',
      ABX_REMOTE_OK_TOKEN: 'fine',
      ABX_REMOTE_TOKEN: 'the generic var, not a typo',
      UNRELATED_KEY: 'x',
    }),
    [
      {key: 'ABX_REMOTE_PROD_KEY', suggestion: 'ABX_REMOTE_PROD_TOKEN'},
      {key: 'ABX_REMOTE_STAGE_API_KEY', suggestion: 'ABX_REMOTE_STAGE_TOKEN'},
    ],
  );
});

test('requireRemoteToken points at the near-miss var when one explains the missing token', () => {
  const env = {ABX_REMOTE_PROD_URL: 'https://x', ABX_REMOTE_PROD_KEY: 'k'};
  const target = resolveRemote('prod', undefined, env)!;
  assert.throws(() => requireRemoteToken(target, env), /Found ABX_REMOTE_PROD_KEY .*rename it to ABX_REMOTE_PROD_TOKEN/s);
  // ...and stays quiet when there's no near-miss to blame
  assert.throws(() => requireRemoteToken(resolveRemote('prod', undefined, {ABX_REMOTE_PROD_URL: 'https://x'})!, {}), /set ABX_REMOTE_PROD_TOKEN/);
});

test('listConfiguredRemotes scans ABX_REMOTE_*_URL, reports token presence (never the value), sorted', () => {
  const remotes = listConfiguredRemotes({
    ABX_REMOTE_ZED_URL: 'https://z/',
    ABX_REMOTE_ART_URL: 'https://a',
    ABX_REMOTE_ART_TOKEN: 'secret',
    ABX_REMOTE_ORPHAN_TOKEN: 'no-url-so-invisible',
    UNRELATED: 'x',
  });
  assert.deepEqual(remotes, [
    {name: 'ABX', url: 'https://services.abx.io', hasToken: false},
    {name: 'ART', url: 'https://a', hasToken: true},
    {name: 'ZED', url: 'https://z', hasToken: false},
  ]);
});

// A 401 has to name the credential it ACTUALLY used. Blaming the env var when the caller passed
// --remote-token makes the override look ignored — precisely when someone is testing a replacement key.
test('a 401 attributes the rejected credential to its real source (flag vs env)', () => {
  const env = {ABX_REMOTE_PROV_URL: 'https://p.example', ABX_REMOTE_PROV_TOKEN: 'stale'};
  const fromEnv = resolveRemote('prov', undefined, env)!;
  const fromFlag = resolveRemote('prov', 'a-replacement', env)!;
  assert.equal(fromEnv.tokenFrom, 'env');
  assert.equal(fromFlag.tokenFrom, 'flag');
  assert.equal(tokenSourceLabel(fromEnv), 'ABX_REMOTE_PROV_TOKEN');
  assert.match(tokenSourceLabel(fromFlag), /--remote-token/);

  const unauthorized = new AbxServiceError('nope', {status: 401, code: 'unauthorized', url: 'https://p.example/v1/projects'});
  assert.match(describeRemoteError(unauthorized, fromEnv, 'remote list').message, /rejected ABX_REMOTE_PROV_TOKEN/);
  const flagMsg = describeRemoteError(unauthorized, fromFlag, 'remote list').message;
  assert.match(flagMsg, /rejected the token you passed with --remote-token/);
  assert.doesNotMatch(flagMsg, /rejected ABX_REMOTE_PROV_TOKEN/);
});

// `not_registered` on a READ (status/reindex) almost always means the bridge step was never done —
// name the fix, not the 404.
test('not_registered names the register command instead of echoing a 404', () => {
  const t = resolveRemote('prov', undefined, {ABX_REMOTE_PROV_URL: 'https://p.example', ABX_REMOTE_PROV_TOKEN: 'k'})!;
  const err = new AbxServiceError('nope', {status: 404, code: 'not_registered', url: 'https://p.example/v1/projects/1/0xa/status'});
  assert.match(describeRemoteError(err, t, 'remote status').message, /abx add <address> --remote prov/);
});

// A credential-free failure CLASS on a 5xx is the difference between "wait, it retries" and
// "something is broken" — the only thing a scrubbed 500 can usefully tell a caller.
test('a 5xx carrying a failure class becomes a wait-vs-broken error, not a bare 500', () => {
  const t = resolveRemote('prov', undefined, {ABX_REMOTE_PROV_URL: 'https://p.example', ABX_REMOTE_PROV_TOKEN: 'k'})!;
  for (const cls of ['rpc_rate_limited', 'rpc_unavailable'] as const) {
    const err = new AbxServiceError('500', {status: 503, code: 'internal_error', class: cls, url: 'https://p.example'});
    const msg = describeRemoteError(err, t, 'remote add').message;
    assert.match(msg, new RegExp(cls));
    assert.match(msg, /not your credential and not your address/);
  }
});
