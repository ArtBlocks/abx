/** Node-only transport for untrusted artwork URLs. Operator RPC/database traffic does not use it. */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, type Socket } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import ipaddr from 'ipaddr.js';

export interface PublicNetworkOptions {
  /** Explicit operator-owned origins, e.g. a co-located resolver. Never derive this from artwork. */
  allowOrigins?: readonly string[];
  lookup?: (host: string) => Promise<readonly { address: string; family: number }[]>;
}

export class ContentNetworkError extends Error {
  constructor(message = 'Content destination must be a public HTTP(S) address.') {
    super(message);
    this.name = 'ContentNetworkError';
  }
}

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    // URL normalisation turns dotted IPv4-compatible literals into hex (::7f00:1).
    // These deprecated transition addresses are not public destinations.
    if (parsed.kind() === 'ipv6' && parsed.match(ipaddr.parse('::'), 96)) return false;
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}

function finalResponseStatus(status: number | undefined): number {
  if (status === undefined || !Number.isInteger(status) || status < 200 || status > 599)
    throw new ContentNetworkError('Content response has an invalid HTTP status.');
  return status;
}

/** Validate all answers, then pin the selected address for the actual connection. */
export async function contentDestination(url: URL, options: PublicNetworkOptions = {}) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ContentNetworkError();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const trusted = options.allowOrigins?.includes(url.origin) ?? false;
  const addresses =
    host === 'localhost' || host.endsWith('.localhost')
      ? [{ address: '127.0.0.1', family: 4 }]
      : ipaddr.isValid(host)
        ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv4' ? 4 : 6 }]
        : await (options.lookup ?? ((name) => dnsLookup(name, { all: true, verbatim: true })))(host);
  if (!addresses.length || (!trusted && addresses.some((a) => !isPublicAddress(a.address))))
    throw new ContentNetworkError();
  return addresses.find((answer) => answer.family === 4) ?? addresses[0]!;
}

export interface PublicFetchOptions extends PublicNetworkOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

let activeFetches = 0;
const waitingFetches = new Set<() => void>();
async function enterFetch(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (activeFetches < 8) {
    activeFetches++;
    return;
  }
  if (waitingFetches.size >= 1024) throw new ContentNetworkError('Content fetch capacity exceeded; retry shortly.');
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      waitingFetches.delete(start);
      reject(signal.reason);
    };
    const start = () => {
      waitingFetches.delete(start);
      signal.removeEventListener('abort', abort);
      activeFetches++;
      resolve();
    };
    waitingFetches.add(start);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** One bounded fetch budget for all untrusted content reads in this process. */
export async function fetchPublicContent(
  input: string | URL | Request,
  init: RequestInit = {},
  options: PublicFetchOptions = {},
): Promise<Response> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 10_000),
    ...(init.signal ? [init.signal] : []),
  ]);
  await enterFetch(signal);
  try {
    return await fetchContentInternal(input, { ...init, signal }, options);
  } finally {
    activeFetches--;
    waitingFetches.values().next().value?.();
  }
}

/** GET/HEAD only; redirect checks, bounded decoded bodies, and one total deadline. */
async function fetchContentInternal(
  input: string | URL | Request,
  init: RequestInit = {},
  options: PublicFetchOptions = {},
): Promise<Response> {
  let url = new URL(input instanceof Request ? input.url : input);
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') throw new ContentNetworkError('Content fetch supports GET and HEAD only.');
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 10_000),
    ...(init.signal ? [init.signal] : []),
  ]);
  const headers = new Headers(init.headers);
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  for (let hop = 0; ; hop++) {
    signal.throwIfAborted();
    const target = await abortable(contentDestination(url, options), signal);
    signal.throwIfAborted();
    const response = await new Promise<Response>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method,
          signal,
          agent: false,
          family: target.family,
          headers: Object.fromEntries(headers),
          lookup: (_host, _opts, cb) => cb(null, target.address, target.family),
        },
        (res) => {
          try {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
            }
            const status = finalResponseStatus(res.statusCode);
            if ([301, 302, 303, 307, 308].includes(status) || method === 'HEAD') {
              res.destroy();
              const result = new Response(null, { status, headers: responseHeaders });
              Object.defineProperty(result, 'url', { value: url.href });
              resolve(result);
              return;
            }
            let body: Readable = res;
            const encoding = responseHeaders.get('content-encoding');
            const decoder =
              encoding === 'gzip'
                ? createGunzip()
                : encoding === 'br'
                  ? createBrotliDecompress()
                  : encoding === 'deflate'
                    ? createInflate()
                    : null;
            if (decoder) {
              res.on('error', (err) => decoder.destroy(err));
              body = res.pipe(decoder);
              responseHeaders.delete('content-encoding');
              responseHeaders.delete('content-length');
            }
            void (async () => {
              const chunks: Buffer[] = [];
              let size = 0;
              try {
                for await (const chunk of body) {
                  size += Buffer.byteLength(chunk);
                  if (size > maxBytes) throw new ContentNetworkError('Content response exceeds the byte limit.');
                  chunks.push(Buffer.from(chunk));
                }
                const result = new Response(
                  [204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks)),
                  { status, headers: responseHeaders },
                );
                Object.defineProperty(result, 'url', { value: url.href });
                resolve(result);
              } catch (error) {
                body.destroy();
                res.destroy();
                reject(error);
              }
            })();
          } catch (error) {
            res.destroy();
            reject(error);
          }
        },
      );
      req.on('error', reject);
      req.end();
    });
    if (
      ![301, 302, 303, 307, 308].includes(response.status) ||
      !response.headers.has('location') ||
      init.redirect === 'manual'
    )
      return response;
    if (init.redirect === 'error' || hop >= (options.maxRedirects ?? 5))
      throw new ContentNetworkError('Content redirect limit exceeded.');
    const next = new URL(response.headers.get('location')!, url);
    if (next.origin !== url.origin)
      for (const header of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(header);
    url = next;
  }
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Keep web traffic on the checked proxy, including loopback and WebRTC traffic. */
export const CONTENT_BROWSER_ARGS = [
  '--proxy-bypass-list=<-loopback>',
  '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

/** Loopback-only forward proxy. CONNECT resolves and pins destinations before opening a tunnel. */
export async function startContentProxy(
  options: PublicNetworkOptions = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(120_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    return socket;
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '');
      if (url.protocol !== 'http:') throw new ContentNetworkError();
      const target = await abortable(contentDestination(url, options), AbortSignal.timeout(10_000));
      if (req.destroyed || res.destroyed) return;
      const headers: import('node:http').OutgoingHttpHeaders = { ...req.headers, host: url.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = httpRequest(
        {
          hostname: target.address,
          port: Number(url.port || 80),
          path: url.pathname + url.search,
          method: req.method,
          headers,
          agent: false,
          family: target.family,
        },
        (response) => {
          try {
            res.writeHead(finalResponseStatus(response.statusCode), response.headers);
            response.on('error', () => res.destroy());
            response.pipe(res);
          } catch {
            response.destroy();
            if (!res.headersSent) res.writeHead(502);
            res.end();
          }
        },
      );
      upstream.on('socket', track);
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    })().catch(() => {
      if (!res.destroyed && !res.writableEnded) {
        if (!res.headersSent) res.writeHead(403);
        res.end('Content network destination refused.');
      }
    });
  });
  server.on('connection', (socket) => {
    if (sockets.size >= 256) socket.destroy();
    else track(socket);
  });
  server.on('upgrade', (req, client, head) => {
    void (async () => {
      const url = new URL(req.url ?? '');
      if (url.protocol === 'ws:') url.protocol = 'http:';
      if (url.protocol !== 'http:') throw new ContentNetworkError();
      const target = await abortable(contentDestination(url, options), AbortSignal.timeout(10_000));
      if (client.destroyed) return;
      const upstream = track(connect({ host: target.address, port: Number(url.port || 80), family: target.family }));
      upstream.once('connect', () => {
        const headers = Object.entries(req.headers)
          .filter(([name]) => !name.startsWith('proxy-'))
          .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
          .join('\r\n');
        upstream.write(`${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers}\r\n\r\n`);
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    })().catch(() => client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  });
  server.on('connect', (req, client, head) => {
    void (async () => {
      const url = new URL(`https://${req.url}`);
      const target = await abortable(contentDestination(url, options), AbortSignal.timeout(10_000));
      if (client.destroyed) return;
      const upstream = track(connect({ host: target.address, port: Number(url.port || 443), family: target.family }));
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    })().catch(() => client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Chromium needs OS paths and locale, not the host's provider and storage credentials. */
export function contentBrowserEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TZ',
    'TMPDIR',
    'TMP',
    'TEMP',
    'PLAYWRIGHT_BROWSERS_PATH',
    'FONTCONFIG_PATH',
    'FONTCONFIG_FILE',
  ];
  return Object.fromEntries(keep.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]!]])));
}
