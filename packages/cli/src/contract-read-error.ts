/**
 * Viem wraps a failed `eth_call` in one or more error objects. Walk that chain so callers can
 * distinguish a truthful capability miss (the target does not implement a getter) from an RPC
 * failure (the node did not answer reliably). Collapsing both to `undefined` produces confident,
 * false contract classifications whenever a public endpoint flakes.
 */
function errorNames(error: unknown): string[] {
  const names: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('name' in current && typeof current.name === 'string') names.push(current.name);
    current = 'cause' in current ? current.cause : undefined;
  }
  return names;
}

/** A revert/no-data/decode failure is evidence that this contract lacks the probed getter. */
export function isMissingContractCapability(error: unknown): boolean {
  return errorNames(error).some((name) =>
    [
      'ContractFunctionRevertedError',
      'ContractFunctionZeroDataError',
      'AbiDecodingZeroDataError',
      'AbiDecodingDataSizeTooSmallError',
    ].includes(name),
  );
}

/** Is the failed contract read evidence about the node rather than the target contract's shape? */
export function isRpcReadFailure(error: unknown): boolean {
  // Viem may wrap a revert in an execution layer that also contains RPC-ish names. The truthful
  // contract-level classification is stronger and must win.
  if (isMissingContractCapability(error)) return false;
  return errorNames(error).some(
    (name) =>
      name.endsWith('RpcError') ||
      ['HttpRequestError', 'WebSocketRequestError', 'SocketClosedError', 'TimeoutError'].includes(name),
  );
}
