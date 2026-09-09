// The scaffold builders are pure (files + steps from options), so the artifact shape is unit-testable
// without touching a cloud account. Guards two regressions from the Sepolia rehearsals: (1) the
// no-domain resolver used to bake a dead `<app>.example` base; (2) the effects runner was hand-written
// as a browserless `node:24-slim` image that couldn't render.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {effectsArtifact, resolverArtifact} from '../src/provision.js';

const fileIn = (art: {files: Array<{path: string; content: string}>}, path: string): string => {
  const f = art.files.find((x) => x.path === path);
  assert.ok(f, `missing ${path}`);
  return f!.content;
};

test('resolver (fly, no domain): bakes the REAL platform hostname, never a .example placeholder', () => {
  const art = resolverArtifact({provider: 'fly', app: 'abx-resolver', chain: 'sepolia'});
  assert.equal(art.baseUrl, 'https://abx-resolver.fly.dev');
  const toml = fileIn(art, 'fly.toml');
  assert.match(toml, /ABX_PUBLIC_BASE_URL = "https:\/\/abx-resolver\.fly\.dev"/);
  assert.doesNotMatch(toml, /\.example/); // the dead-placeholder bug
  assert.match(toml, /memory = "512mb"/); // from-source tsx OOMs on fly's 256MB default (caught in e2e)
  // the hosted marker that lets the resolver refuse a localhost/placeholder base
  assert.match(fileIn(art, 'Dockerfile'), /ABX_HOSTED=1/);
  // fly preflight is the first printed step (don't blind-send them to `flyctl auth login`)
  assert.match(art.steps[0], /fly version && fly auth whoami/);
});

test('resolver (fly, with domain): bakes the custom domain; render uses onrender.com', () => {
  const fly = resolverArtifact({provider: 'fly', app: 'meta', domain: 'meta.you.xyz'});
  assert.equal(fly.baseUrl, 'https://meta.you.xyz');
  assert.match(fileIn(fly, 'fly.toml'), /ABX_PUBLIC_BASE_URL = "https:\/\/meta\.you\.xyz"/);

  const render = resolverArtifact({provider: 'render', app: 'abx-resolver'});
  assert.equal(render.baseUrl, 'https://abx-resolver.onrender.com');
  assert.match(fileIn(render, 'render.yaml'), /ABX_HOSTED/);
});

test('effects runner: Playwright base image (chromium baked), abx-effects entrypoint, resolver + memory wiring', () => {
  const art = effectsArtifact({
    app: 'drift-effects',
    resolverUrl: 'https://drift.fly.dev',
    chain: 'sepolia',
    storageBackend: 'arweave',
    sourcePackages: ['packages/sdk', 'packages/effects'],
  });
  const dockerfile = fileIn(art, 'Dockerfile.effects');
  assert.match(dockerfile, /^FROM mcr\.microsoft\.com\/playwright:/m); // NOT the browserless node:24-slim the agent hand-wrote
  assert.match(dockerfile, /ENTRYPOINT \["pnpm", "abx-effects"\]/);
  assert.match(dockerfile, /COPY packages\/sdk\/package\.json/);
  assert.match(dockerfile, /COPY packages\/effects\/package\.json/);

  const toml = fileIn(art, 'fly.toml');
  assert.match(toml, /ABX_RESOLVER_URL = "https:\/\/drift\.fly\.dev"/);
  assert.match(toml, /ABX_STORAGE_BACKEND = "arweave"/);
  assert.match(toml, /memory = "1gb"/); // chromium needs headroom
  assert.match(toml, /dockerfile = "Dockerfile\.effects"/);
});
