/**
 * `resolveEffectsTarget` — the co-located-vs-remote decision behind `abx effects`, split out as a
 * pure function so the `--resolver-port` / stale-token interaction is
 * unit-testable without a chain client or an HTTP server.
 *
 * Reproduction: a project that had earlier run `deploy-resolver`/`deploy-effects` carries a
 * leftover `ABX_REMOTE_SELF_TOKEN` in `.env` forever after. A LATER, unrelated `abx effects` run in
 * that same project — meant to be plain co-located rendering against a local `abx serve` on a
 * non-default port — silently flipped into remote/control-plane mode because of that stale token,
 * then 404'd against a resolver that never implements the control plane, with no render ever landing.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveEffectsTarget} from '../src/commands/service.js';
import type {Flags} from '../src/flags.js';

const NO_ENV: NodeJS.ProcessEnv = {};

test('default (no flags, no env): co-located against the documented default port, no token', () => {
  const target = resolveEffectsTarget({} as Flags, NO_ENV);
  assert.equal(target.resolverUrl, 'http://localhost:8787');
  assert.equal(target.adminToken, undefined);
  assert.equal(target.localOnly, false);
  assert.equal(target.loopbackTokenWarning, undefined);
});

test('--resolver-port alone: co-located at that port, no token needed', () => {
  const target = resolveEffectsTarget({'resolver-port': '8837'} as unknown as Flags, NO_ENV);
  assert.equal(target.resolverUrl, 'http://localhost:8837');
  assert.equal(target.adminToken, undefined);
  assert.equal(target.localOnly, true);
  assert.equal(target.loopbackTokenWarning, undefined);
});

test('the sweep repro: --resolver-port IGNORES a stale ABX_REMOTE_SELF_TOKEN, and warns nothing (co-location was explicit)', () => {
  const env = {ABX_REMOTE_SELF_TOKEN: 'stale-token-from-an-earlier-deploy-resolver-run'};
  const target = resolveEffectsTarget({'resolver-port': '8837'} as unknown as Flags, env);
  assert.equal(target.resolverUrl, 'http://localhost:8837');
  assert.equal(target.adminToken, undefined, '--resolver-port must force co-located mode even with a token present');
  assert.equal(target.localOnly, true);
  assert.equal(target.loopbackTokenWarning, undefined);
});

test('WITHOUT --resolver-port, a stale token + ABX_RESOLVER_URL pointed at a loopback abx serve still forces remote mode, but now WARNS', () => {
  const env = {ABX_RESOLVER_URL: 'http://localhost:8837', ABX_REMOTE_SELF_TOKEN: 'stale-token'};
  const target = resolveEffectsTarget({} as Flags, env);
  assert.equal(target.resolverUrl, 'http://localhost:8837');
  assert.equal(target.adminToken, 'stale-token');
  assert.equal(target.localOnly, false);
  assert.ok(target.loopbackTokenWarning, 'must warn — this combination 404s on every render with no other signal');
  assert.match(target.loopbackTokenWarning!, /--resolver-port/);
});

test('a token against a genuinely remote (non-loopback) URL never warns', () => {
  const env = {ABX_RESOLVER_URL: 'https://my-resolver.fly.dev', ABX_REMOTE_SELF_TOKEN: 'real-token'};
  const target = resolveEffectsTarget({} as Flags, env);
  assert.equal(target.resolverUrl, 'https://my-resolver.fly.dev');
  assert.equal(target.adminToken, 'real-token');
  assert.equal(target.loopbackTokenWarning, undefined);
});

test('explicit --remote <url> with an explicit --remote-token wins over --resolver-port and env, and never warns even against a loopback URL', () => {
  // --remote-token is passed explicitly (not via env) so this stays hermetic — resolveRemote's
  // ad-hoc-URL branch would otherwise read the real process.env.ABX_REMOTE_SELF_TOKEN.
  const flags = {remote: 'http://localhost:9999', 'remote-token': 'explicit-token', 'resolver-port': '8837'} as unknown as Flags;
  const target = resolveEffectsTarget(flags, NO_ENV);
  assert.equal(target.resolverUrl, 'http://localhost:9999');
  assert.equal(target.adminToken, 'explicit-token');
  assert.equal(target.localOnly, false, 'an explicit --remote is never "local only", even alongside --resolver-port');
  assert.equal(target.loopbackTokenWarning, undefined, 'explicit --remote intent is never second-guessed');
});
