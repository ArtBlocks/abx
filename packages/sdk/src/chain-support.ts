import registryJson from './chain-support.json' with {type: 'json'};

export type ChainEnvironment = 'testnet' | 'production';
export type ContractDeploymentStatus = 'not-deployed' | 'deployed' | 'superseded';
export type ChainSupportLevel = 'disabled' | 'experimental' | 'beta' | 'supported' | 'deprecated';

/** Stable network facts consumed by the SDK, CLI, services, and agent skill. */
export interface ChainSupport {
  readonly key: string;
  readonly chainId: number;
  readonly name: string;
  readonly environment: ChainEnvironment;
  /** The testnet/production counterpart used when qualifying a release. */
  readonly pairedChain: string;
  /** Whether canonical ABX contracts exist on this chain. */
  readonly contractStatus: ContractDeploymentStatus;
  /** Whether this release permits the CLI to operate on the chain. */
  readonly supportLevel: ChainSupportLevel;
}

export interface ChainSupportRegistry {
  readonly schemaVersion: 1;
  readonly defaultChain: string;
  readonly chains: readonly ChainSupport[];
}

const ENVIRONMENTS = new Set<ChainEnvironment>(['testnet', 'production']);
const CONTRACT_STATUSES = new Set<ContractDeploymentStatus>(['not-deployed', 'deployed', 'superseded']);
const SUPPORT_LEVELS = new Set<ChainSupportLevel>(['disabled', 'experimental', 'beta', 'supported', 'deprecated']);
const SELECTABLE_LEVELS = new Set<ChainSupportLevel>(['experimental', 'beta', 'supported']);

function loadRegistry(input: unknown): ChainSupportRegistry {
  if (!input || typeof input !== 'object') throw new Error('Invalid chain-support registry');
  const registry = input as {schemaVersion?: unknown; defaultChain?: unknown; chains?: unknown};
  if (registry.schemaVersion !== 1) throw new Error(`Unsupported chain-support schema: ${registry.schemaVersion}`);
  if (typeof registry.defaultChain !== 'string' || !registry.defaultChain) {
    throw new Error('Chain-support registry must name a default chain');
  }
  if (!Array.isArray(registry.chains) || registry.chains.length === 0) {
    throw new Error('Chain-support registry must contain at least one chain');
  }

  const chains = registry.chains as unknown as ChainSupport[];
  const keys = new Set<string>();
  const ids = new Set<number>();
  for (const chain of chains) {
    if (!chain || typeof chain !== 'object') throw new Error('Invalid chain-support entry');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(chain.key) || keys.has(chain.key)) {
      throw new Error(`Duplicate or invalid chain key: ${chain.key}`);
    }
    if (!Number.isSafeInteger(chain.chainId) || chain.chainId <= 0 || ids.has(chain.chainId)) {
      throw new Error(`Duplicate or invalid chain id: ${chain.chainId}`);
    }
    if (!chain.name || !ENVIRONMENTS.has(chain.environment)) throw new Error(`Invalid chain metadata: ${chain.key}`);
    if (!CONTRACT_STATUSES.has(chain.contractStatus)) throw new Error(`Invalid contract status: ${chain.key}`);
    if (!SUPPORT_LEVELS.has(chain.supportLevel)) throw new Error(`Invalid support level: ${chain.key}`);
    keys.add(chain.key);
    ids.add(chain.chainId);
  }

  for (const chain of chains) {
    const paired = chains.find((candidate) => candidate.key === chain.pairedChain);
    if (!paired || paired.pairedChain !== chain.key || paired.environment === chain.environment) {
      throw new Error(`Invalid paired chain: ${chain.key} -> ${chain.pairedChain}`);
    }
  }

  const defaultChain = chains.find((chain) => chain.key === registry.defaultChain);
  if (!defaultChain || defaultChain.environment !== 'testnet' || !SELECTABLE_LEVELS.has(defaultChain.supportLevel)) {
    throw new Error(`Invalid default chain: ${registry.defaultChain}`);
  }

  return {schemaVersion: 1, defaultChain: registry.defaultChain, chains};
}

export const CHAIN_SUPPORT_REGISTRY = loadRegistry(registryJson);
export const CHAIN_SUPPORT = CHAIN_SUPPORT_REGISTRY.chains;

export function chainSupportByKey(key: string): ChainSupport | undefined {
  return CHAIN_SUPPORT.find((chain) => chain.key === key);
}

export function chainSupportById(chainId: number): ChainSupport | undefined {
  return CHAIN_SUPPORT.find((chain) => chain.chainId === chainId);
}

export function isChainSelectable(chain: ChainSupport): boolean {
  return SELECTABLE_LEVELS.has(chain.supportLevel);
}

export function isProductionChain(chain: ChainSupport): boolean {
  return chain.environment === 'production';
}
