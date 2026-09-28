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

## Analytics

`instrumentation-client.ts` initialises PostHog. Both variables are read at build time and are
public by design; the project key is write-only and cannot read data back out.

| Variable                   | Required | Default                    |
| -------------------------- | -------- | -------------------------- |
| `NEXT_PUBLIC_POSTHOG_KEY`  | yes      | unset, analytics disabled  |
| `NEXT_PUBLIC_POSTHOG_HOST` | no       | `https://us.i.posthog.com` |

Leave the key unset for local development and forks. Never put a PostHog **personal** API key in a
`NEXT_PUBLIC_` variable — those are secret and grant read access to the project.
