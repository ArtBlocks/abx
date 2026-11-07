import type { ProjectState } from './types.js';

/** Project projections are public protocol data. Transport configuration stays with the host. */
export function publicProjectState(state: ProjectState): ProjectState {
  const { rpcUrl: _rpcUrl, ...publicState } = state;
  return publicState;
}
