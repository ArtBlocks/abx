/** Collection-scoped browser origins for HTTP resolvers. These do not change on-chain URIs. */
export interface ProjectContentPolicy {
  publicBaseUrl: string;
  contentDomain?: string;
  contentScheme: 'http:' | 'https:';
}

export interface ContentProjectKey {
  chainId: number;
  address: string;
}

/** Advertised by a resolver so tooling does not invent provider-specific hostnames. */
export function projectContentDiscovery(policy: ProjectContentPolicy): {domain: string; liveViewUrlTemplate: string} | null {
  return policy.contentDomain
    ? {
        domain: policy.contentDomain,
        liveViewUrlTemplate: `${policy.contentScheme}//{chainId}-{address}.${policy.contentDomain}/a/{chainId}/{address}/{tokenId}`,
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
    throw new Error('content domain is too long for collection subdomains');
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

/** The direct URL retains the protocol path and query; only the origin changes. */
export function projectContentUrl(policy: ProjectContentPolicy, pathAndQuery: string): string | null {
  if (!policy.contentDomain) return null;
  const source = new URL(pathAndQuery, policy.publicBaseUrl);
  const key = contentProjectFromPath(source.pathname);
  if (!key) return null;
  const target = new URL(`${policy.contentScheme}//${key.chainId}-${key.address}.${policy.contentDomain}`);
  target.pathname = source.pathname;
  target.search = source.search;
  target.hash = source.hash;
  return target.href;
}

/** Content hosts have only collection-scoped reads: no account, control, admin or other collection. */
export function projectContentRequestKind(policy: ProjectContentPolicy, requestUrl: string): 'public' | 'content' | 'reject' | 'health' {
  if (!policy.contentDomain) return 'public';
  const url = new URL(requestUrl);
  const domain = new URL(`${policy.contentScheme}//${policy.contentDomain}`);
  if (url.hostname === domain.hostname) return url.pathname === '/health' ? 'health' : 'reject';
  if (!url.hostname.endsWith(`.${domain.hostname}`)) return 'public';
  if (url.port !== domain.port) return 'reject';
  const label = url.hostname.slice(0, -(domain.hostname.length + 1));
  const match = /^([1-9][0-9]*)-(0x[0-9a-f]{40})$/.exec(label);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return 'reject';
  if (url.pathname === '/abx.js') return 'content';
  const key = contentProjectFromPath(url.pathname);
  if (!key || key.chainId !== Number(match[1]) || key.address !== match[2]) return 'reject';
  const metadata =
    /^\/t\/[1-9][0-9]*\/0x[0-9a-fA-F]{40}\/(?:0|[1-9][0-9]*)\/?$/.test(url.pathname) ||
    /^\/c\/[1-9][0-9]*\/0x[0-9a-fA-F]{40}\/?$/.test(url.pathname);
  return metadata || isProjectContentPath(url.pathname) ? 'content' : 'reject';
}

const FRAME_SCRIPT =
  "var u=new URL(document.querySelector('link[rel=canonical]').href);if(location.hash)u.hash=location.hash;if(window.top===window.self)location.replace(u.href);else if(location.hash)addEventListener('DOMContentLoaded',function(){document.querySelector('iframe').src=u.href})";
const FRAME_STYLE = 'html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}';
const FRAME_CSP =
  "default-src 'none'; script-src 'sha256-rAyFgUSzOSuMXzNFRfx/9rm050qrUtEJ8dlg5Z1H6WE='; style-src 'sha256-eTEQdSHa5lZRfHLn1XshWyk4v3jQTf8RRe46YvvjOi8='; base-uri 'none'; form-action 'none'";
const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A marketplace may copy this HTML; the actual program always executes at its collection origin. */
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
export function isolateProjectContent(policy: ProjectContentPolicy, requestUrl: string, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('origin-agent-cluster', '?1');
  headers.set('cross-origin-opener-policy', policy.contentDomain ? 'same-origin-allow-popups' : 'noopener-allow-popups');
  const url = new URL(requestUrl);
  if (response.status >= 200 && response.status < 300) {
    const target = projectContentUrl(policy, url.pathname + url.search);
    if (!policy.contentDomain || !target) {
      // Applies to navigated SVG/XML and MIME variants too, without having to guess which types execute.
      headers.append(
        'content-security-policy',
        'sandbox allow-scripts allow-forms allow-modals allow-pointer-lock allow-presentation allow-downloads allow-popups allow-popups-to-escape-sandbox',
      );
    } else if (projectContentRequestKind(policy, requestUrl) === 'public') {
      const cache = headers.get('cache-control') ?? 'no-store';
      // Byte artifacts must remain byte-exact. Only the assembled live view uses a wrapper.
      if (url.pathname.startsWith('/a/') && /^text\/html(?:\s*;|$)/i.test(headers.get('content-type') ?? '')) {
        return projectContentFrame(target, cache);
      }
      return new Response(null, {
        status: 302,
        headers: {location: target, link: `<${target}>; rel="canonical"`, 'cache-control': cache, 'x-content-type-options': 'nosniff'},
      });
    }
  }
  return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
}
