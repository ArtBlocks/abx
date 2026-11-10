import type {Flags} from './flags.js';

/** Public utility discovery only. Operations and deployment registries belong to each utility's packages. */
export const ABX_UTILITIES = [
  {
    id: 'abxfs',
    name: 'ABX FS',
    summary: 'On-chain files and directories with compression, project ownership, versions, and tags.',
    entrypoint: 'https://fs.abx.io',
    documentation: 'https://docs.fs.abx.io',
    repository: 'https://github.com/ArtBlocks/abxfs',
    optional: true,
    packages: {
      cli: '@artblocks/abxfs-cli',
      sdk: '@artblocks/abxfs-sdk',
      gateway: '@artblocks/abxfs-gateway',
      pinning: '@artblocks/abxfs-pinning',
    },
    installation: {
      cli: 'pnpm add --save-dev @artblocks/abxfs-cli',
      sdk: 'pnpm add @artblocks/abxfs-sdk',
    },
    useFor: ['static websites and dapps', 'project assets and documents', 'preservation', 'shared on-chain resources'],
    operations: ['upload', 'read', 'update', 'versions and tags', 'presentation', 'optional IPFS pinning'],
    discovery: ['abxfs --help', 'abxfs presentation --help'],
    chainSelection: 'Use ABX FS help and its canonical deployment registry; its CLI takes --chain or ABXFS_CHAIN.',
    compatibility: {
      source: 'The installed ABX FS SDK registry and project generation are authoritative.',
      presentationCapability: 'projectPresentation',
      nativeReaderCapability: 'contentReader',
      existingProjects: 'Resolve the factory generation that created the org; older orgs retain their original behavior.',
    },
    presentation: {
      auto: 'Embed suitable small self-contained content; otherwise use the chain gateway.',
      ipfs: 'Explicit opt-in with creator-managed pinning and ongoing availability costs.',
      locks: ['displayed root and entrypoint', 'delivery method', 'gateway endpoints'],
    },
    boundaries: [
      'ABX FS packages perform the work; abx utils does not install or execute them.',
      'ABX FS has its own signing configuration; ABX signing lanes do not automatically carry over.',
      'An ABX FS project is separate from an ABX collection using its files.',
      'A gateway serves preserved bytes but remains an off-chain delivery dependency.',
    ],
  },
] as const;

export function cmdUtils(args: string[], flags: Flags): void {
  if (args.length > 1) throw new Error('usage: abx utils [utility] [--json]');
  const selected = args[0] ? ABX_UTILITIES.find((utility) => utility.id === args[0]) : undefined;
  if (args[0] && !selected) throw new Error(`Unknown ABX utility ${JSON.stringify(args[0])}. Run abx utils to list available utilities.`);
  if (flags.json !== undefined) {
    console.log(JSON.stringify(selected ?? {schemaVersion: 1, utilities: ABX_UTILITIES}, null, 2));
    return;
  }
  if (!selected) {
    for (const utility of ABX_UTILITIES) console.log(`${utility.id}: ${utility.summary}\n  ${utility.entrypoint}`);
    console.log('\nUse abx utils <utility> for optional packages and integration boundaries.');
    return;
  }
  console.log(`${selected.name} — ${selected.summary}\n${selected.entrypoint}\nDocs: ${selected.documentation}`);
  console.log(`\nOptional CLI: ${selected.installation.cli}\nOptional SDK: ${selected.installation.sdk}`);
  console.log(`\nUse for: ${selected.useFor.join(', ')}\n${selected.chainSelection}`);
  console.log(`\nAuto: ${selected.presentation.auto}\nIPFS: ${selected.presentation.ipfs}`);
  for (const boundary of selected.boundaries) console.log(`- ${boundary}`);
}
