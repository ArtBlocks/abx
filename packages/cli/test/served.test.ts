import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchServedTokenUri, prettyBody, servedOk} from '../src/served.js';

/**
 * `abx tokenuri --fetch`. No command printed the served JSON body: `tokenuri` read the
 * chain, `verify` re-hashed bytes, `status` reported the lifecycle. An agent in a cold sweep fell back
 * to raw `curl`, which is the tell that a command was missing.
 *
 * The behaviours worth pinning are the ones where the *honest* answer isn't the obvious one.
 */

const res = (init: {status: number; body?: string; contentType?: string}) =>
  ({
    status: init.status,
    headers: new Headers(init.contentType ? {'content-type': init.contentType} : {}),
    text: async () => init.body ?? '',
  }) as unknown as Response;

test('a data: URI is NOT a failure — it IS the document, and it says so', async () => {
  // A fully-on-chain project's whole point is that there is no server to ask. Reporting this as an
  // error would punish the strongest configuration the protocol offers.
  const s = await fetchServedTokenUri('data:application/json;base64,eyJuYW1lIjoiWCJ9', {
    fetchFn: (async () => {
      throw new Error('must not be called');
    }) as unknown as typeof fetch,
  });
  assert.equal(s.url, null);
  assert.equal(s.status, null);
  assert.match(s.skipped!, /IS the document/);
  assert.match(s.skipped!, /no server to ask/);
});

test('a non-http, non-data tokenURI is skipped with the value quoted back', async () => {
  const s = await fetchServedTokenUri('ipfs://QmSomething/0.json');
  assert.equal(s.url, null);
  assert.match(s.skipped!, /not an http\(s\) URL/);
  assert.match(s.skipped!, /ipfs:/);
});

test('a served 200 body comes back verbatim and untruncated', async () => {
  const body = JSON.stringify({name: 'Cats #0', image: 'ipfs://Qm/0.png', padding: 'x'.repeat(5000)});
  const s = await fetchServedTokenUri('https://api.provider.xyz/t/1/0xabc/0', {
    fetchFn: (async () => res({status: 200, body, contentType: 'application/json'})) as unknown as typeof fetch,
  });
  assert.equal(s.status, 200);
  assert.equal(servedOk(s), true);
  // Untruncated in the DATA: only the human readout clips, and it says how many chars it clipped.
  assert.equal(s.body, body);
  assert.equal(s.contentType, 'application/json');
});

test("a provider's 404 is captured with its body — the mismatch case, made visible", async () => {
  // The point of --fetch over a warning: registering with one provider while a different base is
  // baked on-chain shows up as THAT provider's answer, rather than as a check that guesses (and
  // false-positives on the common custom-domain setup).
  const s = await fetchServedTokenUri('https://baked.example/t/1/0xabc/0', {
    fetchFn: (async () =>
      res({status: 404, body: '{"error":"this node does not index that contract"}', contentType: 'application/json'})) as unknown as typeof fetch,
  });
  assert.equal(s.status, 404);
  assert.equal(servedOk(s), false);
  assert.match(s.body!, /does not index that contract/);
});

test('a host that never answers is distinguished from a served error status', async () => {
  // These route to different advice: "your provider said no" vs "the URL a marketplace will ask is
  // dead". Collapsing them would send someone to fix the wrong thing.
  const s = await fetchServedTokenUri('https://dead.example/t/1/0xabc/0', {
    fetchFn: (async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch,
  });
  assert.equal(s.status, null);
  assert.equal(s.error, 'fetch failed');
  assert.equal(servedOk(s), false);
});

test('a timeout is reported as a timeout, with the budget named', async () => {
  const s = await fetchServedTokenUri('https://slow.example/t/1/0xabc/0', {
    timeoutMs: 20,
    fetchFn: ((_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
      })) as unknown as typeof fetch,
  });
  assert.equal(s.status, null);
  assert.match(s.error!, /no response in 20ms/);
});

test('prettyBody formats JSON and passes non-JSON through untouched', () => {
  assert.equal(prettyBody('{"a":1}'), '{\n  "a": 1\n}');
  // A provider's HTML error page is still worth seeing verbatim rather than swallowed.
  assert.equal(prettyBody('<html>502 Bad Gateway</html>'), '<html>502 Bad Gateway</html>');
  assert.equal(prettyBody(null), '');
});

test('servedOk is true only for 2xx', () => {
  const base = {url: 'u', skipped: null, contentType: null, body: null};
  for (const status of [200, 201, 204, 299]) assert.equal(servedOk({...base, status}), true);
  for (const status of [199, 301, 400, 404, 500]) assert.equal(servedOk({...base, status}), false);
  assert.equal(servedOk({...base, status: null}), false);
});
