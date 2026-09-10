import {isAddress, type Address} from 'viem';
import registryJson from './contract-generations.json' with {type: 'json'};

/** Human-facing lifecycle. Code should dispatch on `support`, not this label. */
export type GenerationLifecycle = 'current' | 'supported' | 'deprecated' | 'quarantined';

/** Operations that ABX software may allow for a known contract generation. */
export interface GenerationSupport {
  readonly newDeployments: boolean;
  readonly reads: boolean;
  readonly writes: boolean;
  readonly serving: boolean;
}

export type GenerationOperation = keyof GenerationSupport;

/** One immutable generation of the six clone factories. */
export interface AnchorGeneration {
  /** Stable registry identifier. Never reuse or rename after publication. */
  readonly id: string;
  /** The value clones report from `abxVersion()`. */
  readonly coreVersion: number;
  readonly lifecycle: GenerationLifecycle;
  /** ISO date the generation first went live. */
  readonly deployed: string;
  /** ISO date it was superseded, when applicable. */
  readonly retired?: string;
  /** Explicit compatibility policy for SDKs, indexers, and resolvers. */
  readonly support: GenerationSupport;
  /** The six trust anchors. Shared singletons and libraries do not belong here. */
  readonly factories: {
    readonly factory: Address;
    readonly seriesFactory: Address;
    readonly seriesCodeFactory: Address;
    readonly oneOfOneEditionFactory: Address;
    readonly editionFactory: Address;
    readonly editionCodeFactory: Address;
  };
  readonly note?: string;
}

const FACTORY_KEYS = [
  'factory',
  'seriesFactory',
  'seriesCodeFactory',
  'oneOfOneEditionFactory',
  'editionFactory',
  'editionCodeFactory',
] as const;

const LIFECYCLES = new Set<GenerationLifecycle>(['current', 'supported', 'deprecated', 'quarantined']);
const OPERATIONS: readonly GenerationOperation[] = ['newDeployments', 'reads', 'writes', 'serving'];

function loadRegistry(input: unknown): readonly AnchorGeneration[] {
  if (!input || typeof input !== 'object') throw new Error('Invalid contract-generation registry');
  const registry = input as {schemaVersion?: unknown; generations?: unknown};
  if (registry.schemaVersion !== 1) throw new Error(`Unsupported contract-generation schema: ${registry.schemaVersion}`);
  if (!Array.isArray(registry.generations) || registry.generations.length === 0) {
    throw new Error('Contract-generation registry must contain at least one generation');
  }

  const generations = registry.generations as unknown as AnchorGeneration[];
  const ids = new Set<string>();
  const versions = new Set<number>();
  for (const generation of generations) {
    if (!generation || typeof generation !== 'object') throw new Error('Invalid contract generation');
    if (!generation.id || ids.has(generation.id)) throw new Error(`Duplicate or missing generation id: ${generation.id}`);
    if (!Number.isSafeInteger(generation.coreVersion) || versions.has(generation.coreVersion)) {
      throw new Error(`Duplicate or invalid core version: ${generation.coreVersion}`);
    }
    if (!LIFECYCLES.has(generation.lifecycle)) throw new Error(`Invalid lifecycle for ${generation.id}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(generation.deployed)) throw new Error(`Invalid deployed date for ${generation.id}`);
    if (generation.retired && !/^\d{4}-\d{2}-\d{2}$/.test(generation.retired)) {
      throw new Error(`Invalid retired date for ${generation.id}`);
    }
    for (const operation of OPERATIONS) {
      if (typeof generation.support?.[operation] !== 'boolean') {
        throw new Error(`Missing ${operation} support policy for ${generation.id}`);
      }
    }
    for (const key of FACTORY_KEYS) {
      if (!isAddress(generation.factories?.[key])) throw new Error(`Invalid ${key} for ${generation.id}`);
    }
    if (Object.keys(generation.factories).length !== FACTORY_KEYS.length) {
      throw new Error(`Generation ${generation.id} must contain exactly six factories`);
    }
    ids.add(generation.id);
    versions.add(generation.coreVersion);
  }

  const current = generations.filter((generation) => generation.lifecycle === 'current');
  if (current.length !== 1 || generations[0] !== current[0]) {
    throw new Error('Exactly one current contract generation must appear first');
  }
  if (!current[0].support.newDeployments || current[0].retired) {
    throw new Error('The current contract generation must allow new deployments and cannot be retired');
  }
  if (generations.some((generation) => generation.lifecycle !== 'current' && generation.support.newDeployments)) {
    throw new Error('Only the current contract generation may allow new deployments');
  }
  if (generations.some((generation) => generation.lifecycle !== 'current' && !generation.retired)) {
    throw new Error('Every prior contract generation must record when it was retired');
  }
  for (let index = 1; index < generations.length; index += 1) {
    if (generations[index - 1].coreVersion <= generations[index].coreVersion) {
      throw new Error('Contract generations must be newest-first by core version');
    }
  }
  return generations;
}

/** Append-only, newest-first registry of published ABX contract generations. */
export const ANCHOR_GENERATIONS = loadRegistry(registryJson);

export function currentAnchorGeneration(): AnchorGeneration {
  return ANCHOR_GENERATIONS[0];
}

export function findAnchorGenerationById(id: string): AnchorGeneration | undefined {
  return ANCHOR_GENERATIONS.find((generation) => generation.id === id);
}

export function findAnchorGenerationByCoreVersion(coreVersion: number): AnchorGeneration | undefined {
  return ANCHOR_GENERATIONS.find((generation) => generation.coreVersion === coreVersion);
}

export function findAnchorGenerationByFactory(factory: Address): AnchorGeneration | undefined {
  const needle = factory.toLowerCase();
  return ANCHOR_GENERATIONS.find((generation) =>
    Object.values(generation.factories).some((candidate) => candidate.toLowerCase() === needle),
  );
}

export function supportsGenerationOperation(
  generation: AnchorGeneration,
  operation: GenerationOperation,
): boolean {
  return generation.support[operation];
}
