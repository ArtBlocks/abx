import {CHAIN_SUPPORT, DEFAULT_CHAIN_KEY, KNOWN_CHAIN_KEYS} from '@artblocks/abx-sdk';
import type {Flags} from './flags.js';

/**
 * The machine-readable ABX capability contract.
 *
 * Keep this deliberately smaller than command help: it records product boundaries and the
 * supported combinations agents routinely get wrong. Command-specific syntax still belongs to
 * `abx help <command>`, while deploy planning belongs to `<deploy-command> --dry-run --json`.
 * Human help, the shipped skill, and tests consume this object instead of maintaining competing
 * matrices in prose.
 */
export const ABX_CAPABILITIES = {
  schemaVersion: 2,
  defaultChain: DEFAULT_CHAIN_KEY,
  chains: CHAIN_SUPPORT,
  /** Compatibility field for consumers that only need selectable chain keys. */
  supportedChains: [...KNOWN_CHAIN_KEYS],
  deploymentCommands: {
    deploy: {
      artifact: 'one static work',
      unique: {
        contract: 'OneOfOneImage (ERC-721)',
        inputs: ['--image'],
      },
      edition: {
        contract: 'OneOfOneEdition (ERC-1155)',
        selector: '--copies <n|open>',
        summary: 'one work × copies; supports on-chain bytes, on-chain JSON with external media, or a resolver',
        supported: ['--onchain-image (hot or wallet signing)', '--onchain-uri', '--backend', '--public-base-url'],
        unsupported: ['--onchain-image with --unsigned'],
      },
    },
    deploySeries: {
      artifact: 'a folder of distinct static works',
      unique: {
        contract: 'SeriesImage (ERC-721)',
        inputs: ['--dir'],
      },
      edition: {
        contract: 'EditionImage (ERC-1155)',
        selector: '--copies <n|open>',
        summary: 'N folder items × copies per id; supports on-chain bytes, on-chain JSON with external media, or a resolver',
        supported: ['--onchain-image (hot or wallet signing)', '--onchain-uri', '--backend', '--public-base-url'],
        unsupported: ['--onchain-image with --unsigned'],
      },
    },
    deployCode: {
      artifact: 'a program or field renderer whose output depends on token state',
      unique: {
        contract: 'SeriesCode (ERC-721)',
        inputs: ['--script', '--code-dir', '--image-renderer', '--attributes-renderer'],
      },
      edition: {
        contract: 'EditionCode (ERC-1155)',
        selector: '--copies <n|open>',
        summary: 'N generated ids × copies per id; supports scripts, directory builds, dependencies, deterministic per-id off-chain stills, and Solidity image/trait renderers',
        supported: ['--script', '--code-dir', '--dep', '--dep-registry', '--image-renderer', '--attributes-renderer', '--image-base', '--onchain-uri', '--public-base-url'],
        // `--resume` isn't listed in `supported`/`unsupported` at all (neither lane lists it — it's a
        // REPAIR verb against an EXISTING contract, not a deploy-time flag): `abx deploy-code --resume
        // <address>` now diffs an EditionCode target's per-id mint shortfall exactly as it always has
        // for a 721 SeriesCode target (see resume.ts's `planEditionResume`).
        unsupported: ['--no-delegation'],
      },
    },
  },
  extensionRoutes: [
    {
      route: 'custom minter',
      command: 'abx set-minter',
      availableOn: 'Series and editions',
      useFor: ['auctions', 'allowlists', 'raffles', 'free claims', 'ERC-20 pricing'],
    },
    {
      route: 'configure hook',
      command: 'abx set-param-hooks --configure',
      availableOn: 'SeriesCode and EditionCode',
      useFor: ['validated writes', 'monotonic values', 'structured collector input'],
    },
    {
      route: 'transfer hook',
      command: 'abx set-param-hooks --transfer',
      availableOn: 'SeriesCode and EditionCode',
      useFor: ['transfer restrictions', 'soulbinding', 'vesting', 'redemption', 'escrow'],
    },
    {
      route: 'augment hook',
      command: 'abx set-param-hooks --augment',
      availableOn: 'SeriesCode and EditionCode',
      useFor: ['live derived data', 'oracle-fed state', 'read-time metadata'],
    },
    {
      route: 'field renderer',
      command: 'abx deploy-code --image-renderer/--attributes-renderer',
      availableOn: 'SeriesCode and EditionCode',
      useFor: ['on-chain SVG images', 'on-chain computed traits'],
    },
    {
      route: 'replace an unlocked script',
      command: 'abx replace-script',
      availableOn: 'SeriesCode and EditionCode, before `abx lock-script`',
      useFor: ['shipping a fix to a live generative program', 'iterating pre-lock without a full redeploy'],
    },
  ],
  deployTimeChoices: [
    'contract shape and token standard (--copies)',
    'code-capable versus static contract type',
    'burnability (--burnable)',
    'ERC-721C/ERC-1155C enrollment (--721c)',
  ],
  unsupportedToday: [
    'production networks (recognized in the chain registry, but disabled in this release)',
    'unsupported chains',
    'secondary-market listings or an order book',
    'compiling or deploying custom Solidity through abx',
    'retrofitting a deploy-time choice on an existing collection',
  ],
  interpretation: {
    native: 'A documented command/flag combination performs the request directly.',
    extension: 'A canonical extension seam performs it while the token remains a factory clone.',
    unsupported: 'The request is listed under unsupportedToday or is blocked by an irreversible choice already made.',
    unknown: 'Do not infer support from absence. Inspect command help, contract type, and this contract; report uncertainty if no route is proven.',
  },
} as const;

export function cmdCapabilities(flags: Flags): void {
  if (flags.json !== undefined) {
    console.log(JSON.stringify(ABX_CAPABILITIES, null, 2));
    return;
  }

  console.log('ABX capability contract v2\n');
  console.log(`Default chain: ${ABX_CAPABILITIES.defaultChain}`);
  console.log('Networks:');
  for (const chain of ABX_CAPABILITIES.chains) {
    console.log(
      `  ${chain.key} (${chain.chainId}): ${chain.environment} · ${chain.supportLevel} · contracts ${chain.contractStatus}`,
    );
  }
  console.log('Native deployment lanes:');
  for (const [name, lane] of Object.entries(ABX_CAPABILITIES.deploymentCommands)) {
    console.log(`  ${name}: ${lane.artifact}`);
    console.log(`    unique  ${lane.unique.contract} — ${lane.unique.inputs.join(' | ')}`);
    console.log(`    edition ${lane.edition.contract} — ${lane.edition.summary}`);
    if (lane.edition.unsupported.length) console.log(`    limits  ${lane.edition.unsupported.join(' · ')}`);
  }

  console.log('\nCanonical extension routes:');
  for (const seam of ABX_CAPABILITIES.extensionRoutes) {
    console.log(`  ${seam.route}: ${seam.availableOn} — ${seam.useFor.join(', ')}`);
  }

  console.log('\nUnsupported today:');
  for (const item of ABX_CAPABILITIES.unsupportedToday) console.log(`  - ${item}`);

  console.log('\nUse `abx capabilities --json` for the stable machine-readable form,');
  console.log('`abx help <command>` for current flags, and `<deploy-command> --dry-run --json` for a concrete plan.');
}
