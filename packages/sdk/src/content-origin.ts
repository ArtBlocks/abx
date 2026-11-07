import {sha256, toBytes, hexToBytes, bytesToHex} from 'viem';

/** Token-scoped browser origins for HTTP resolvers. These do not change on-chain URIs. */
export interface ProjectContentPolicy {
  publicBaseUrl: string;
  contentDomain?: string;
  contentScheme: 'http:' | 'https:';
}

export interface ContentProjectKey {
  chainId: number;
  address: string;
}

/** A token document, or a separate collection-artifact origin when tokenId is absent. */
export interface ContentRouteKey extends ContentProjectKey {
  tokenId?: string;
}
export const TOKEN_CONTENT_SCHEME = 'token-sha256-base32-v1' as const;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Canonical UTF-8 serialization, shared with independently implemented resolver indexes. */
export function contentRouteDigest(key: ContentRouteKey): `0x${string}` {
  if (!Number.isSafeInteger(key.chainId) || key.chainId < 1 || !/^0x[0-9a-fA-F]{40}$/.test(key.address))
    throw new Error('invalid content project coordinates');
  if (key.tokenId !== undefined && (!/^(0|[1-9][0-9]*)$/.test(key.tokenId) || key.tokenId.length > 78 || BigInt(key.tokenId) >= 2n ** 256n))
    throw new Error('invalid uint256 content token id');
  const scope = key.tokenId === undefined ? 'collection' : 'token';
  return sha256(
    toBytes(`abx-content-v1:${scope}:${key.chainId}:${key.address.toLowerCase()}${key.tokenId === undefined ? '' : `:${key.tokenId}`}`),
  );
}

/** Full SHA-256 in lowercase, unpadded RFC 4648 base32: 54 characters including the scope. */
export function contentOriginLabel(key: ContentRouteKey): string {
  let bits = 0,
    value = 0,
    encoded = '';
  for (const byte of hexToBytes(contentRouteDigest(key))) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits) encoded += BASE32[(value << (5 - bits)) & 31];
  return `${key.tokenId === undefined ? 'c' : 't'}-${encoded}`;
}

/** Recover the digest for an indexed lookup; reject noncanonical padding bits and nested labels. */
export function contentDigestFromLabel(label: string): `0x${string}` | null {
  if (!/^[tc]-[a-z2-7]{52}$/.test(label)) return null;
  let bits = 0,
    value = 0;
  const bytes: number[] = [];
  for (const char of label.slice(2)) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
    value &= (1 << bits) - 1;
  }
  return value === 0 ? bytesToHex(new Uint8Array(bytes)) : null;
}

/** Advertised by a resolver so tooling does not invent provider-specific hostnames. */
export function projectContentDiscovery(
  policy: ProjectContentPolicy,
): {domain: string; liveViewUrlTemplate: string; scheme: typeof TOKEN_CONTENT_SCHEME} | null {
  return policy.contentDomain
    ? {
        domain: policy.contentDomain,
        scheme: TOKEN_CONTENT_SCHEME,
        liveViewUrlTemplate: `${policy.contentScheme}//{tokenOrigin}.${policy.contentDomain}/`,
      }
    : null;
}

/** Validate once at startup. A content domain is a bare DNS host, optionally with a local port. */
export function projectContentPolicy(publicBaseUrl: string, contentDomain?: string): ProjectContentPolicy {
  const base = new URL(publicBaseUrl);
  if (!contentDomain) return {publicBaseUrl, contentScheme: 'https:'};
  const local = /^localhost(?::[0-9]+)?$/.test(contentDomain);
  const scheme = local ? 'http:' : 'https:';
  const parsed = new URL(`${scheme}//${contentDomain}`);
  if (
    parsed.host !== contentDomain ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    (!local && (parsed.port || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(parsed.hostname)))
  ) {
    throw new Error('content domain must be a lowercase bare DNS host (a port is allowed only on localhost)');
  }
  if (
    parsed.host === base.host ||
    (!local && (base.hostname.endsWith(`.${parsed.hostname}`) || parsed.hostname.endsWith(`.${base.hostname}`)))
  ) {
    throw new Error('content domain must be separate from the resolver host');
  }
  if (parsed.hostname.split('.').some((label) => label.length > 63) || parsed.hostname.length > 190)
    throw new Error('content domain is too long for token subdomains');
  return {publicBaseUrl, contentDomain, contentScheme: scheme};
}

/** Parse the protocol coordinates without accepting alternate decimal spellings or encoded separators. */
export function contentProjectFromPath(pathname: string): ContentProjectKey | null {
  const match = /^\/(?:a|t|c)\/([1-9][0-9]*)\/(0x[0-9a-fA-F]{40})(?:\/|$)/.exec(pathname);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
  return {chainId: Number(match[1]), address: match[2].toLowerCase()};
}

/** All routes that can return publisher-controlled bytes, including images and arbitrary artifacts. */
export function isProjectContentPath(pathname: string): boolean {
  return (
    /^\/a\/[1-9][0-9]*\/0x[0-9a-fA-F]{40}\/(?:0|[1-9][0-9]*)\/?$/.test(pathname) ||
    /^\/t\/[1-9][0-9]*\/0x[0-9a-fA-F]{40}\/(?:0|[1-9][0-9]*)\/(?:image|data\/[^/]+(?:\/[^/]+)?)\/?$/.test(pathname) ||
    /^\/c\/[1-9][0-9]*\/0x[0-9a-fA-F]{40}\/data\/[^/]+\/?$/.test(pathname)
  );
}

/** Parse all public token/collection reads. Byte routes are identified separately. */
export function contentRouteFromPath(pathname: string): ContentRouteKey | null {
  const project = contentProjectFromPath(pathname);
  if (!project) return null;
  if (/^\/c\/[^/]+\/[^/]+(?:\/data\/[^/]+)?\/?$/.test(pathname)) return project;
  const token = /^\/(?:a|t)\/[^/]+\/[^/]+\/(0|[1-9][0-9]*)(?:\/|$)/.exec(pathname);
  if (!token || (!isProjectContentPath(pathname) && !/^\/t\/[^/]+\/[^/]+\/[^/]+\/?$/.test(pathname))) return null;
  const key = {...project, tokenId: token[1]};
  try {
    contentRouteDigest(key);
    return key;
  } catch {
    return null;
  }
}

/** Artwork lives at /; artifact and metadata paths remain compatible, scoped to their token. */
export function projectContentUrl(policy: ProjectContentPolicy, pathAndQuery: string): string | null {
  if (!policy.contentDomain) return null;
  const source = new URL(pathAndQuery, policy.publicBaseUrl);
  const key = contentRouteFromPath(source.pathname);
  if (!key) return null;
  const target = new URL(`${policy.contentScheme}//${contentOriginLabel(key)}.${policy.contentDomain}`);
  target.pathname = source.pathname.startsWith('/a/') ? '/' : source.pathname;
  target.search = source.search;
  target.hash = source.hash;
  return target.href;
}

/** Hash on the configured content suffix, for a resolver's persistent reverse index. */
export function contentRequestLabel(policy: ProjectContentPolicy, requestUrl: string): string | null {
  if (!policy.contentDomain) return null;
  const url = new URL(requestUrl),
    domain = new URL(`${policy.contentScheme}//${policy.contentDomain}`);
  if (url.port !== domain.port || !url.hostname.endsWith(`.${domain.hostname}`)) return null;
  const label = url.hostname.slice(0, -(domain.hostname.length + 1));
  return contentDigestFromLabel(label) ? label : null;
}

/** Resolve a token's root to the stable protocol route after an indexed lookup. */
export function contentRootPath(label: string, key: ContentRouteKey): string | null {
  if (contentOriginLabel(key) !== label || key.tokenId === undefined) return null;
  return `/a/${key.chainId}/${key.address.toLowerCase()}/${key.tokenId}`;
}

/** Only a token's own reads are admitted. Legacy collection hosts are trusted entrypoints only. */
export function projectContentRequestKind(
  policy: ProjectContentPolicy,
  requestUrl: string,
): 'public' | 'content' | 'legacy' | 'reject' | 'health' {
  if (!policy.contentDomain) return 'public';
  const url = new URL(requestUrl);
  const domain = new URL(`${policy.contentScheme}//${policy.contentDomain}`);
  if (url.hostname === domain.hostname) {
    if (domain.hostname === 'localhost') return 'public';
    return url.pathname === '/health' ? 'health' : 'reject';
  }
  if (!url.hostname.endsWith(`.${domain.hostname}`)) return 'public';
  if (url.port !== domain.port) return 'reject';
  const label = url.hostname.slice(0, -(domain.hostname.length + 1));
  const key = contentRouteFromPath(url.pathname);
  if (contentDigestFromLabel(label)) {
    if ((url.pathname === '/' || url.pathname === '/abx.js') && label.startsWith('t-')) return 'content';
    return key && contentOriginLabel(key) === label ? 'content' : 'reject';
  }
  const legacy = /^([1-9][0-9]*)-(0x[0-9a-f]{40})$/.exec(label);
  return legacy && key && key.chainId === Number(legacy[1]) && key.address === legacy[2] ? 'legacy' : 'reject';
}

/** Use discovered templates, including older collection hosts; unknown schemes use the resolver. */
export function discoveredLiveViewUrl(
  baseUrl: string,
  content: {liveViewUrlTemplate: string; scheme?: string} | undefined,
  key: ContentRouteKey,
): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === '/') end--;
  const fallback = new URL(`${baseUrl.slice(0, end)}/a/${key.chainId}/${key.address}/${key.tokenId}`).href;
  if (
    !content ||
    typeof content.liveViewUrlTemplate !== 'string' ||
    key.tokenId === undefined ||
    (content.scheme && content.scheme !== TOKEN_CONTENT_SCHEME)
  )
    return fallback;
  const values: Record<string, string> = {
    chainId: String(key.chainId),
    address: key.address.toLowerCase(),
    tokenId: key.tokenId,
    tokenOrigin: contentOriginLabel(key),
  };
  const result = content.liveViewUrlTemplate.replace(/\{(chainId|address|tokenId|tokenOrigin)\}/g, (match, name: string) => values[name] ?? match);
  if (/[{}]/.test(result)) return fallback;
  try {
    const url = new URL(result);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : fallback;
  } catch {
    return fallback;
  }
}

const FRAME_SCRIPT =
  "var u=new URL(document.querySelector('link[rel=canonical]').href);if(location.hash)u.hash=location.hash;if(window.top===window.self)location.replace(u.href);else if(location.hash)addEventListener('DOMContentLoaded',function(){document.querySelector('iframe').src=u.href})";
const FRAME_STYLE = 'html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}';
const FRAME_CSP =
  "default-src 'none'; script-src 'sha256-rAyFgUSzOSuMXzNFRfx/9rm050qrUtEJ8dlg5Z1H6WE='; style-src 'sha256-eTEQdSHa5lZRfHLn1XshWyk4v3jQTf8RRe46YvvjOi8='; base-uri 'none'; form-action 'none'";
const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A marketplace may copy this HTML; the actual program always executes at its token origin. */
export function projectContentFrame(url: string, cacheControl = 'no-store'): Response {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('content frames require an HTTP(S) URL without credentials');
  }
  const src = escapeAttribute(url);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ABX project</title><link rel="canonical" href="${src}"><script>${FRAME_SCRIPT}</script><style>${FRAME_STYLE}</style><iframe src="${src}" allow="autoplay; fullscreen; clipboard-write; encrypted-media; picture-in-picture; accelerometer; gyroscope; xr-spatial-tracking" allowfullscreen></iframe>`,
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': cacheControl,
        'content-security-policy': `${FRAME_CSP}; frame-src ${new URL(url).origin}`,
        link: `<${url}>; rel="canonical"`,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cross-origin-opener-policy': 'noopener-allow-popups',
        'origin-agent-cluster': '?1',
      },
    },
  );
}

/** Apply to every publisher byte response. Without DNS configuration, documents use opaque origins. */
export function isolateProjectContent(
  policy: ProjectContentPolicy,
  requestUrl: string,
  response: Response,
  fetchDestination?: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('origin-agent-cluster', '?1');
  headers.set('cross-origin-opener-policy', policy.contentDomain ? 'same-origin-allow-popups' : 'noopener-allow-popups');
  const url = new URL(requestUrl);
  if (response.status >= 200 && response.status < 300) {
    const target = projectContentUrl(policy, url.pathname + url.search);
    if (projectContentRequestKind(policy, requestUrl) === 'content') {
      // The router has verified the token scope (and reverse-indexed a root request).
    } else if (!policy.contentDomain || !target) {
      // Applies to navigated SVG/XML and MIME variants too, without having to guess which types execute.
      headers.append(
        'content-security-policy',
        'sandbox allow-scripts allow-forms allow-modals allow-pointer-lock allow-presentation allow-downloads allow-popups allow-popups-to-escape-sandbox',
      );
    } else if (['public', 'legacy'].includes(projectContentRequestKind(policy, requestUrl))) {
      const cache = headers.get('cache-control') ?? 'no-store';
      const liveView = url.pathname.startsWith('/a/') && /^text\/html(?:\s*;|$)/i.test(headers.get('content-type') ?? '');
      // Browser navigation follows HTTP redirects so capturers see the final document's status.
      // Frames and server-side marketplace downloads retain the copyable wrapper. This hint only
      // selects between two safe representations; it never permits publisher bytes on this origin.
      if (liveView && fetchDestination !== 'document') {
        const frame = projectContentFrame(target, cache);
        frame.headers.set('vary', 'Sec-Fetch-Dest');
        return frame;
      }
      return new Response(null, {
        status: 302,
        headers: {
          location: target,
          link: `<${target}>; rel="canonical"`,
          'cache-control': cache,
          'x-content-type-options': 'nosniff',
          ...(liveView ? {vary: 'Sec-Fetch-Dest'} : {}),
        },
      });
    }
  }
  return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
}
