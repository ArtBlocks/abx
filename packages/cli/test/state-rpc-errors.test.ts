import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type {Address} from 'viem';
import {cmdStateBody} from '../src/commands/project.js';

const TARGET = '0x1111111111111111111111111111111111111111' as Address;
const RPC_ENV = ['ABX_RPC_URLS', 'ABX_RPC_URLS_BASE_SEPOLIA', 'ABX_RPC_URLS_SEPOLIA'] as const;

type RpcReply = {result: unknown} | {error: {code: number; message: string}};

function stubRpc(reply: (method: string) => RpcReply): Promise<{url: string; close: () => Promise<void>}> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as {id?: unknown; method?: string};
        const answer = reply(parsed.method ?? '');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({jsonrpc: '2.0', id: parsed.id ?? 1, ...answer}));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address() as {port: number};
      resolve({url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => server.close(() => done()))});
    });
  });
}

async function withRpcEnv(url: string, fn: () => Promise<void>): Promise<void> {
  const keys = ['ABX_RPC_URL', ...RPC_ENV] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  delete process.env.ABX_RPC_URL;
  for (const key of RPC_ENV) process.env[key] = url;
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const runState = () => cmdStateBody(TARGET, {}, () => undefined);

test('state refuses the ignored singular RPC variable before reading a public default', async () => {
  const keys = ['ABX_RPC_URL', ...RPC_ENV] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  process.env.ABX_RPC_URL = 'http://127.0.0.1:1';
  for (const key of RPC_ENV) delete process.env[key];
  try {
    await assert.rejects(runState, /ABX_RPC_URL \(singular\) is set but is not read.*refusing to ignore/);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a valid plural RPC variable takes precedence without a false singular-variable refusal', async () => {
  const rpc = await stubRpc((method) => {
    if (method === 'eth_blockNumber') return {result: '0x1'};
    if (method === 'eth_chainId') return {result: '0x14a34'};
    return {result: '0x'};
  });
  try {
    await withRpcEnv(rpc.url, async () => {
      process.env.ABX_RPC_URL = 'http://127.0.0.1:1';
      await assert.rejects(runState, (error: Error) => {
        assert.match(error.message, /no contract at/);
        assert.doesNotMatch(error.message, /ABX_RPC_URL \(singular\)/);
        return true;
      });
    });
  } finally {
    await rpc.close();
  }
});

test('state calls an endpoint unreachable when even the head probe fails', async () => {
  const rpc = await stubRpc(() => ({error: {code: -32011, message: 'no backend healthy'}}));
  try {
    await withRpcEnv(rpc.url, async () => {
      await assert.rejects(runState, /could not reach the .* RPC.*This is not a fact about/);
    });
  } finally {
    await rpc.close();
  }
});

test('state does not call a contract non-ABX when the RPC refuses eth_call', async () => {
  const rpc = await stubRpc((method) => {
    if (method === 'eth_blockNumber') return {result: '0x1'};
    if (method === 'eth_getCode') return {result: '0x6080604052'};
    if (method === 'eth_chainId') return {result: '0x14a34'};
    return {error: {code: -32005, message: 'rate limit exceeded'}};
  });
  try {
    await withRpcEnv(rpc.url, async () => {
      await assert.rejects(runState, (error: Error) => {
        assert.match(error.message, /RPC answered block\/code requests but failed eth_call/);
        assert.match(error.message, /This is not a contract verdict/);
        assert.doesNotMatch(error.message, /is not an ABX token/);
        return true;
      });
    });
  } finally {
    await rpc.close();
  }
});

test('state still identifies code whose required getters return no data as non-ABX', async () => {
  const rpc = await stubRpc((method) => {
    if (method === 'eth_blockNumber') return {result: '0x1'};
    if (method === 'eth_getCode') return {result: '0x6080604052'};
    if (method === 'eth_chainId') return {result: '0x14a34'};
    return {result: '0x'};
  });
  try {
    await withRpcEnv(rpc.url, async () => {
      await assert.rejects(runState, /has code on .* but is not an ABX token \(no usable owner\/supply getters\)/);
    });
  } finally {
    await rpc.close();
  }
});
