/**
 * URI-lock safety shared by the CLI and SDK consumers.
 *
 * An ABX URI pointer is mutable until its scope is locked. Locking a provider-owned hostname would
 * make that provider a permanent dependency even though the creator does not control its DNS.
 * ABX Services does not currently offer creator custom-domain routing, so its own domain is never a
 * safe lock target.
 */

/** True when a URI is hosted at the ABX apex domain or any of its subdomains. */
export function isAbxIoUri(uri: string): boolean {
  if (!uri.trim()) return false;
  try {
    const hostname = new URL(uri).hostname.toLowerCase().replace(/\.$/, '');
    return hostname === 'abx.io' || hostname.endsWith('.abx.io');
  } catch {
    return false;
  }
}

/**
 * Refuse an irreversible URI lock when the current base is controlled by ABX Services.
 * Callers should run this against the live token- or collection-scope base immediately before they
 * prepare the lock transaction.
 */
export function assertUriBaseLockable(uri: string): void {
  if (!isAbxIoUri(uri)) return;
  throw new Error(
    `Refusing to lock URI configuration to ${uri}. ` +
      'An abx.io domain is not controlled by the creator, and ABX Services does not currently support custom-domain routing. ' +
      'Repoint to a domain you control, verify it, then lock that URI.',
  );
}
