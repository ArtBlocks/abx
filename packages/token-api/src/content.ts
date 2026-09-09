import {keccak256, stringToBytes, type Hex} from 'viem';

/**
 * The demo's reference content. A 1/1 needs *bytes* — here they're generated
 * deterministically from the contract address (the seed), so "byte custody" is
 * satisfied by reproducible regeneration plus an on-chain hash commitment: the
 * server can always re-derive the exact image, and anyone can verify it matches
 * what the contract committed. A real custody node stores arbitrary bytes; the
 * verification + serving path is identical.
 *
 * (Generative-from-seed is also a fitting nod to where this protocol comes from.)
 */

export const IMAGE_MEDIA_TYPE = 'image/svg+xml';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic generative SVG for a contract address. Pure: address → bytes. */
export function generateContent(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, '').padEnd(40, '0');
  const seed = parseInt(clean.slice(0, 8), 16) ^ parseInt(clean.slice(8, 16), 16);
  const rnd = mulberry32(seed);

  const hue = Math.floor(rnd() * 360);
  const bg = `hsl(${hue}, 60%, 8%)`;
  const size = 500;
  const cells = 5 + Math.floor(rnd() * 4); // 5–8
  const step = size / cells;

  const shapes: string[] = [];
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      if (rnd() < 0.18) continue; // negative space
      const h = (hue + Math.floor(rnd() * 80) - 40 + 360) % 360;
      const light = 45 + Math.floor(rnd() * 40);
      const fill = `hsl(${h}, ${55 + Math.floor(rnd() * 35)}%, ${light}%)`;
      const cx = x * step + step / 2;
      const cy = y * step + step / 2;
      const r = (step / 2) * (0.35 + rnd() * 0.6);
      const kind = rnd();
      if (kind < 0.45) {
        shapes.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}"/>`);
      } else if (kind < 0.8) {
        const s = (r * 1.6).toFixed(1);
        shapes.push(
          `<rect x="${(cx - r).toFixed(1)}" y="${(cy - r).toFixed(1)}" width="${s}" height="${s}" rx="${(r * 0.2).toFixed(1)}" fill="${fill}" transform="rotate(${Math.floor(rnd() * 90)} ${cx.toFixed(1)} ${cy.toFixed(1)})"/>`,
        );
      } else {
        const x2 = (cx + (rnd() - 0.5) * step).toFixed(1);
        const y2 = (cy + (rnd() - 0.5) * step).toFixed(1);
        shapes.push(
          `<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${x2}" y2="${y2}" stroke="${fill}" stroke-width="${(r * 0.4).toFixed(1)}" stroke-linecap="round"/>`,
        );
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" fill="${bg}"/>`,
    shapes.join(''),
    `</svg>`,
  ].join('');
}

/** keccak256 of the generated content's UTF-8 bytes — the value committed on-chain (image `keccak256` field). */
export function contentHash(address: string): Hex {
  return keccak256(stringToBytes(generateContent(address)));
}

/**
 * The required-field *fallback* image — a simple, deterministic placeholder used when a
 * token has no resolvable `image` (unset, or a representation the surface can't load).
 * Deliberately trivial so it is **byte-identical** to the on-chain renderer's
 * `_fallbackImage` (`AbxMetadataRenderer`): background = the address's first 3 bytes,
 * label = `#tokenId`. Distinct from {generateContent} (the demo's *chosen* content) — this is
 * the "nothing was set" placeholder both the on-chain and off-chain resolvers agree on.
 */
export function fallbackImageSvg(address: string, tokenId: string | number | bigint): string {
  const color = address.toLowerCase().replace(/^0x/, '').slice(0, 6);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">` +
    `<rect width="500" height="500" fill="#${color}"/>` +
    `<text x="250" y="264" font-family="monospace" font-size="42" fill="#ffffff" text-anchor="middle">#${tokenId}</text>` +
    `</svg>`
  );
}
