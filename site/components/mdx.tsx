import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { Mermaid } from '@/components/mdx/mermaid';
import { ArchitectureDiagram } from '@/components/architecture-diagram';
import { CopyAddress } from '@/components/copy-address';
import { BrandKitAssets } from '@/components/brand-kit';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Mermaid,
    ArchitectureDiagram,
    CopyAddress,
    BrandKitAssets,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
