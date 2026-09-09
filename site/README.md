# ABX documentation site

This Next.js/Fumadocs application publishes [docs.abx.io](https://docs.abx.io).

## Development

From the repository root:

```bash
pnpm --dir site dev
pnpm --dir site build
```

Documentation content lives in `content/docs/`. Keep it current with code and CLI changes; it is
the repository's authoritative prose reference.

The landing page is `app/(home)/page.tsx`. Shared MDX components and navigation configuration live
under `components/`, `lib/`, and each section's `meta.json`.
