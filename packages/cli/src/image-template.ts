import { encodeTag, type Address, type Hex } from '@artblocks/abx-sdk';
import { hexToString, toHex } from 'viem';

/** The factory predicts a clone before initialization, so its own namespace can ride init. */
export function collectionImageTemplate(base: string, chainId: number, storageBase?: string): string {
  const template = base.includes('{id}') ? base : `${base.replace(/\/+$/, '')}/{id}.png`;
  const parsed = new URL(template);
  if (!decodeURIComponent(parsed.pathname).includes('{id}'))
    throw new Error('--image-base templates must place {id} in the object path.');
  if (template.includes('{contract}')) return template;
  const configured = storageBase?.replace(/\/+$/, '');
  const root =
    configured && template.startsWith(`${configured}/`)
      ? configured
      : template.slice(0, template.lastIndexOf('/', template.indexOf('{id}')));
  const suffix = template.slice(root.length + 1);
  if (suffix.includes('{contract}')) return template;
  return `${root}/${chainId}/{contract}/${suffix}`;
}

export function resolveImageNamespace<T extends { field: Hex; representation: Hex; value: Hex }>(
  fields: T[],
  contract: Address,
): T[] {
  return fields.map((entry) =>
    entry.field === encodeTag('image') && entry.representation === encodeTag('url-template')
      ? { ...entry, value: toHex(hexToString(entry.value).replaceAll('{contract}', contract.toLowerCase())) }
      : entry,
  );
}
