import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {cmdAuth, deviceLogin, oauthLogout} from '../src/commands/auth.js';

const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const BASE = 'https://provider.example';

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json', ...headers},
  });
}

function successfulFetch(accessToken: string): {fetchImpl: typeof fetch; requests: Array<{url: string; init?: RequestInit}>} {
  const requests: Array<{url: string; init?: RequestInit}> = [];
  let tokenPoll = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({url, init});
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return response({
        issuer: BASE,
        device_authorization_endpoint: `${BASE}/oauth/device_authorization`,
        token_endpoint: `${BASE}/oauth/token`,
        grant_types_supported: [GRANT],
      });
    }
    if (url.endsWith('/oauth/device_authorization')) {
      return response({
        device_code: 'device-code-that-must-never-be-printed',
        user_code: 'ABCD-EFGH',
        verification_uri: `${BASE}/device`,
        verification_uri_complete: `${BASE}/device?user_code=ABCD-EFGH`,
        expires_in: 900,
        interval: 1,
      });
    }
    tokenPoll += 1;
    if (tokenPoll === 1) return response({error: 'authorization_pending'}, 400);
    if (tokenPoll === 2) return response({error: 'slow_down'}, 400);
    return response({access_token: accessToken, token_type: 'Bearer', scope: 'abx-services'});
  };
  return {fetchImpl, requests};
}

test('device login follows discovery + RFC polling, stores the key privately, and never prints either secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-auth-device-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'ABX_CHAIN=base-sepolia\n', {mode: 0o600});
  const accessToken = 'abxk_this-is-the-access-token-and-must-not-print';
  const fake = successfulFetch(accessToken);
  const lines: string[] = [];
  const warnings: string[] = [];
  const sleeps: number[] = [];
  let opened = '';

  await deviceLogin(
    {baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath},
    {
      fetchImpl: fake.fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
      openBrowser: (url) => {
        opened = url;
        return true;
      },
      line: (message) => lines.push(message),
      warning: (message) => warnings.push(message),
    },
  );

  assert.equal(opened, `${BASE}/device?user_code=ABCD-EFGH`);
  assert.deepEqual(sleeps, [1_000, 1_000, 6_000]);
  assert.match(readFileSync(envPath, 'utf8'), /ABX_CHAIN=base-sepolia[\s\S]*ABX_TEST_DEVICE_TOKEN=abxk_/);
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
  const visible = [...lines, ...warnings].join('\n');
  assert.match(visible, /ABCD-EFGH/);
  assert.doesNotMatch(visible, new RegExp(accessToken));
  assert.doesNotMatch(visible, /device-code-that-must-never-be-printed/);

  assert.equal(fake.requests[1]?.init?.method, 'POST');
  assert.match(String(fake.requests[1]?.init?.body), /client_id=abx-cli/);
  assert.doesNotMatch(String(fake.requests[1]?.init?.body), /scope=/);
  assert.match(String(fake.requests[2]?.init?.body), new RegExp(`grant_type=${encodeURIComponent(GRANT)}`));
  assert.match(String(fake.requests[2]?.init?.body), /device_code=device-code-that-must-never-be-printed/);
});

test('an existing key requires --force and replacement preserves unrelated env lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-auth-replace-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'KEEP=this\nABX_TEST_DEVICE_TOKEN=old-secret\nAFTER=that\n', {mode: 0o600});
  await assert.rejects(
    deviceLogin({baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath}, {fetchImpl: successfulFetch('new').fetchImpl}),
    /--force/,
  );

  const fake = successfulFetch('new-secret');
  await deviceLogin(
    {baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath, force: true, noOpen: true},
    {fetchImpl: fake.fetchImpl, sleep: async () => {}, now: () => 0, openBrowser: () => false, line: () => {}, warning: () => {}},
  );
  assert.equal(readFileSync(envPath, 'utf8'), 'KEEP=this\nABX_TEST_DEVICE_TOKEN=new-secret\nAFTER=that\n');
});

test('login refuses to write a credential into tracked or unignored .env files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-auth-git-'));
  execFileSync('git', ['init', '--quiet'], {cwd: dir});
  const envPath = join(dir, '.env');
  await assert.rejects(
    deviceLogin({baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath}, {fetchImpl: successfulFetch('secret').fetchImpl}),
    /not Git-ignored/,
  );

  writeFileSync(join(dir, '.gitignore'), '.env\n');
  writeFileSync(envPath, 'ABX_TEST_DEVICE_TOKEN=tracked-secret\n');
  execFileSync('git', ['add', '-f', '.env'], {cwd: dir});
  await assert.rejects(
    deviceLogin(
      {baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath, force: true},
      {fetchImpl: successfulFetch('secret').fetchImpl},
    ),
    /tracked \.env/,
  );
});

test('a shell credential must be unset because it would shadow the newly stored key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-auth-shadow-'));
  const envPath = join(dir, '.env');
  const prior = process.env.ABX_TEST_DEVICE_TOKEN;
  try {
    for (const shadow of ['shell-secret', '']) {
      process.env.ABX_TEST_DEVICE_TOKEN = shadow;
      await assert.rejects(
        deviceLogin(
          {baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath, force: true},
          {fetchImpl: successfulFetch('secret').fetchImpl},
        ),
        /set outside \.env.*shadow/,
      );
    }
  } finally {
    if (prior === undefined) delete process.env.ABX_TEST_DEVICE_TOKEN;
    else process.env.ABX_TEST_DEVICE_TOKEN = prior;
  }
});

test('a key loaded from the destination file may be replaced, but a conflicting shell value may not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-auth-force-shadow-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'ABX_TEST_DEVICE_TOKEN=file-secret\n', {mode: 0o600});
  const prior = process.env.ABX_TEST_DEVICE_TOKEN;
  try {
    process.env.ABX_TEST_DEVICE_TOKEN = 'file-secret';
    await deviceLogin(
      {baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath, force: true, noOpen: true},
      {
        fetchImpl: successfulFetch('replacement').fetchImpl,
        sleep: async () => {},
        now: () => 0,
        line: () => {},
        warning: () => {},
      },
    );
    assert.equal(readFileSync(envPath, 'utf8'), 'ABX_TEST_DEVICE_TOKEN=replacement\n');

    process.env.ABX_TEST_DEVICE_TOKEN = 'shell-secret';
    await assert.rejects(
      deviceLogin(
        {baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath, force: true},
        {fetchImpl: successfulFetch('another').fetchImpl},
      ),
      /set outside \.env.*shadow/,
    );
  } finally {
    if (prior === undefined) delete process.env.ABX_TEST_DEVICE_TOKEN;
    else process.env.ABX_TEST_DEVICE_TOKEN = prior;
  }
});

test('the destination is rechecked during polling before a one-time token is consumed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-auth-race-'));
  const envPath = join(dir, '.env');
  const fake = successfulFetch('must-not-be-issued');
  let sleeps = 0;
  await assert.rejects(
    deviceLogin(
      {baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath, noOpen: true},
      {
        fetchImpl: fake.fetchImpl,
        sleep: async () => {
          sleeps += 1;
          writeFileSync(envPath, 'ABX_TEST_DEVICE_TOKEN=appeared-during-approval\n', {mode: 0o600});
        },
        now: () => 0,
        line: () => {},
        warning: () => {},
      },
    ),
    /already exists.*--force/,
  );
  assert.equal(sleeps, 1);
  assert.equal(fake.requests.length, 2, 'no token endpoint request was sent after the destination changed');
});

test('discovery follows RFC 8414 issuer-path insertion and rejects an issuer mismatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-auth-discovery-'));
  let requested = '';
  const fetchImpl: typeof fetch = async (input) => {
    requested = String(input);
    return response({
      issuer: 'https://attacker.example',
      device_authorization_endpoint: `${BASE}/oauth/device_authorization`,
      token_endpoint: `${BASE}/oauth/token`,
      grant_types_supported: [GRANT],
    });
  };
  await assert.rejects(
    deviceLogin(
      {baseUrl: `${BASE}/tenant`, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath: join(dir, '.env')},
      {fetchImpl},
    ),
    /OAuth issuer mismatch/,
  );
  assert.equal(requested, `${BASE}/.well-known/oauth-authorization-server/tenant`);
});

test('a provider error cannot reflect the private device code into CLI output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-auth-redact-'));
  const envPath = join(dir, '.env');
  const privateDeviceCode = 'private-device-code-reflected-by-provider';
  let call = 0;
  const fetchImpl: typeof fetch = async () => {
    call += 1;
    if (call === 1) {
      return response({
        issuer: BASE,
        device_authorization_endpoint: `${BASE}/oauth/device_authorization`,
        token_endpoint: `${BASE}/oauth/token`,
        grant_types_supported: [GRANT],
      });
    }
    if (call === 2) {
      return response({
        device_code: privateDeviceCode,
        user_code: 'ABCD-EFGH',
        verification_uri: `${BASE}/device`,
        expires_in: 900,
        interval: 1,
      });
    }
    return response({error: 'invalid_grant', error_description: `bad ${privateDeviceCode}`}, 400);
  };
  await assert.rejects(
    deviceLogin(
      {baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath, noOpen: true},
      {fetchImpl, sleep: async () => {}, now: () => 0, line: () => {}, warning: () => {}},
    ),
    (error: unknown) => {
      assert.match(String(error), /\[redacted\]/);
      assert.doesNotMatch(String(error), new RegExp(privateDeviceCode));
      return true;
    },
  );
});

test('provider credentials must use the RFC 6750 bearer-token grammar before entering .env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-auth-token-shape-'));
  const envPath = join(dir, '.env');
  await assert.rejects(
    deviceLogin(
      {baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath, noOpen: true},
      {
        fetchImpl: successfulFetch('unsafe token').fetchImpl,
        sleep: async () => {},
        now: () => 0,
        line: () => {},
        warning: () => {},
      },
    ),
    /cannot be stored safely/,
  );
  assert.equal(existsSync(envPath), false);
});

test('OAuth logout discovers RFC 7009, revokes first, and removes every matching env assignment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-auth-logout-'));
  const envPath = join(dir, '.env');
  const token = 'abxk_logout-secret';
  writeFileSync(envPath, `KEEP=this\nABX_TEST_DEVICE_TOKEN=${token}\nexport ABX_TEST_DEVICE_TOKEN=${token}\nAFTER=that\n`, {mode: 0o600});
  const requests: Array<{url: string; init?: RequestInit}> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({url, init});
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return response({issuer: BASE, revocation_endpoint: `${BASE}/oauth/revoke`});
    }
    return new Response(null, {status: 200});
  };

  const result = await oauthLogout(
    {baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath, token},
    {fetchImpl},
  );
  assert.deepEqual(result, {status: 'revoked', local: 'removed'});
  assert.equal(readFileSync(envPath, 'utf8'), 'KEEP=this\nAFTER=that\n');
  assert.equal(requests[1]?.url, `${BASE}/oauth/revoke`);
  assert.equal(requests[1]?.init?.method, 'POST');
  const body = String(requests[1]?.init?.body);
  assert.match(body, /client_id=abx-cli/);
  assert.match(body, /token_type_hint=access_token/);
  assert.match(body, new RegExp(`token=${token}`));
});

test('logout keeps the local credential when revocation fails and redacts a reflected token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-auth-logout-failure-'));
  const envPath = join(dir, '.env');
  const token = 'abxk_logout-must-stay-private';
  writeFileSync(envPath, `ABX_TEST_DEVICE_TOKEN=${token}\n`, {mode: 0o600});
  let call = 0;
  const fetchImpl: typeof fetch = async () => {
    call += 1;
    if (call === 1) return response({issuer: BASE, revocation_endpoint: `${BASE}/oauth/revoke`});
    return response({error: 'temporarily_unavailable', error_description: `could not revoke ${token}`}, 503);
  };

  await assert.rejects(
    oauthLogout({baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath, token}, {fetchImpl}),
    (error: unknown) => {
      assert.match(String(error), /OAuth token revocation failed.*\[redacted\]/);
      assert.doesNotMatch(String(error), new RegExp(token));
      return true;
    },
  );
  assert.equal(readFileSync(envPath, 'utf8'), `ABX_TEST_DEVICE_TOKEN=${token}\n`);
});

test('logout never deletes a different file credential and is a no-op when none resolves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-auth-logout-source-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'ABX_TEST_DEVICE_TOKEN=file-token\n', {mode: 0o600});
  let requests = 0;
  const fetchImpl: typeof fetch = async (input) => {
    requests += 1;
    if (String(input).endsWith('/.well-known/oauth-authorization-server')) {
      return response({issuer: BASE, revocation_endpoint: `${BASE}/oauth/revoke`});
    }
    return new Response(null, {status: 200});
  };
  assert.deepEqual(
    await oauthLogout(
      {baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath, token: 'shell-token'},
      {fetchImpl},
    ),
    {status: 'revoked', local: 'different'},
  );
  assert.equal(readFileSync(envPath, 'utf8'), 'ABX_TEST_DEVICE_TOKEN=file-token\n');

  const absentPath = join(dir, 'absent.env');
  assert.deepEqual(
    await oauthLogout({baseUrl: BASE, envVar: 'ABX_TEST_DEVICE_TOKEN', envPath: absentPath}, {fetchImpl}),
    {status: 'absent'},
  );
  assert.equal(requests, 2);
});

test('auth rejects a bare --remote and stray positional arguments before any auth flow starts', async () => {
  await assert.rejects(cmdAuth(['login', '--remote'], {remote: 'true'}), /--remote needs a named remote/);
  await assert.rejects(cmdAuth(['login', 'abx', 'extra'], {}), /usage: abx auth <login\|logout>/);
  await assert.rejects(cmdAuth(['logout', 'abx', 'extra'], {}), /usage: abx auth <login\|logout>/);
});
