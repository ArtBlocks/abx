import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {test} from 'node:test';
import {buildFeedbackReport, cmdFeedback} from '../src/commands/feedback.js';

const CLI = join(import.meta.dirname, '..', 'src', 'main.ts');

test('feedback help makes every closed report enum discoverable', () => {
  const output = execFileSync('node', ['--import', 'tsx', CLI, 'help', 'feedback'], {
    encoding: 'utf8',
    env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
  });
  assert.match(output, /--area <protocol\|contracts\|cli\|sdk\|skills\|docs\|other>/);
  assert.match(output, /--kind <bug\|friction\|gap\|confusion\|praise\|other>/);
  assert.match(output, /--severity <blocker\|major\|minor>/);
  assert.match(output, /--via <agent\|human>/);
});

test('core feedback requires routing fields and builds the exact preview body with CLI context', () => {
  assert.throws(
    () => buildFeedbackReport({summary: 'something happened', kind: 'bug'}, 'abx'),
    /--area is required/,
  );
  const report = buildFeedbackReport(
    {
      area: 'cli',
      kind: 'friction',
      summary: 'progress was silent',
      detail: 'OBSERVED: no progress. EXPECTED: periodic status.',
      severity: 'minor',
      via: 'agent',
      context: '{"command":"abx add <address> --remote abx","sessionId":"session-1"}',
    },
    'abx',
  );
  assert.equal('area' in report! ? report.area : undefined, 'cli');
  assert.equal(report?.context?.command, 'abx add <address> --remote abx');
  assert.equal(report?.context?.sessionId, 'session-1');
  assert.match(String(report?.context?.cliVersion), /^\d+\.\d+\.\d+/);
});

test('provider feedback uses component, rejects core area, and validates enums before sending', () => {
  assert.throws(
    () => buildFeedbackReport({area: 'cli', kind: 'bug', summary: 'wrong target'}, 'service'),
    /--area is for core/,
  );
  assert.throws(
    () => buildFeedbackReport({component: 'renderer', kind: 'severe', summary: 'bad enum'}, 'service'),
    /--kind must be one of/,
  );
  const report = buildFeedbackReport(
    {component: 'renderer', kind: 'bug', summary: 'render stayed pending'},
    'service',
  );
  assert.equal('component' in report! ? report.component : undefined, 'renderer');
  assert.equal(report?.kind, 'bug');
  assert.equal(report?.summary, 'render stayed pending');
  assert.match(String(report?.context?.cliVersion), /^\d+\.\d+\.\d+/);
});

test('no summary means discovery/list mode and malformed context never reaches the service', () => {
  assert.equal(buildFeedbackReport({}, 'abx'), null);
  assert.throws(
    () => buildFeedbackReport({area: 'sdk', kind: 'bug', summary: 'bad context', context: '[]'}, 'abx'),
    /JSON object/,
  );
});

test('core feedback previews without a request and --yes sends only to the canonical ABX endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ABX_SERVICES_API_KEY;
  const originalLog = console.log;
  const seen: Array<{url: string; init?: RequestInit}> = [];
  const output: string[] = [];
  globalThis.fetch = async (input, init) => {
    seen.push({url: String(input), init});
    return new Response(JSON.stringify({ok: true, id: 'fb-core-1', createdAt: '2026-08-25T00:00:00Z'}), {
      status: 201,
      headers: {'content-type': 'application/json'},
    });
  };
  process.env.ABX_SERVICES_API_KEY = 'abxk_private_test_value';
  console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  try {
    const report = {area: 'cli', kind: 'bug', summary: 'preview must not transmit'};
    await cmdFeedback(report);
    assert.equal(seen.length, 0, 'preview performs no external request');
    assert.match(output.join('\n'), /Report content not sent/);

    await cmdFeedback({...report, yes: 'true', json: 'true'});
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, 'https://services.abx.io/abx/feedback');
    assert.equal(seen[0]?.init?.method, 'POST');
    assert.equal((seen[0]?.init?.headers as Record<string, string>).authorization, 'Bearer abxk_private_test_value');
    assert.equal(JSON.parse(String(seen[0]?.init?.body)).summary, report.summary);
    assert.doesNotMatch(output.join('\n'), /abxk_private_test_value/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalKey === undefined) delete process.env.ABX_SERVICES_API_KEY;
    else process.env.ABX_SERVICES_API_KEY = originalKey;
  }
});

test('provider feedback trusts the advertised interface, discovers publicly, and sends to that provider', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const seen: Array<{url: string; init?: RequestInit}> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    seen.push({url, init});
    if (url.endsWith('/.well-known/abx-service')) {
      return new Response(
        JSON.stringify({interfaces: ['abx-token-api/v1', 'abx-service-feedback/v1'], chains: [84532]}),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    }
    return new Response(JSON.stringify({ok: true, id: 'fb-provider-1', createdAt: '2026-08-25T00:00:00Z'}), {
      status: 201,
      headers: {'content-type': 'application/json'},
    });
  };
  console.log = () => {};
  try {
    const flags = {
      remote: 'https://provider.example',
      'remote-token': 'provider-private-test-value',
      component: 'renderer',
      kind: 'bug',
      summary: 'render stayed pending',
    };
    await cmdFeedback(flags);
    assert.equal(seen.length, 1, 'preview performs public descriptor discovery only');
    assert.equal(seen[0]?.url, 'https://provider.example/.well-known/abx-service');
    assert.equal((seen[0]?.init?.headers as Record<string, string>).authorization, undefined);

    await cmdFeedback({...flags, yes: 'true'});
    assert.equal(seen[2]?.url, 'https://provider.example/feedback');
    assert.equal(seen[2]?.init?.method, 'POST');
    assert.equal((seen[2]?.init?.headers as Record<string, string>).authorization, 'Bearer provider-private-test-value');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});
