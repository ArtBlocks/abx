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

The site reports page traffic to PostHog (US cloud) from `instrumentation-client.ts`. It is
disabled unless `NEXT_PUBLIC_POSTHOG_KEY` is set, so local builds and forks send nothing.

Collection is PostHog's automatic instrumentation: pageviews including client-side navigation,
pageleaves, autocaptured clicks and form interactions, and rageclicks. Each event carries the
URL, referrer, campaign parameters, and browser and device details, with location resolved from
the request IP.

Every event is anonymous. The site never calls `identify`, and `person_profiles` is left at its
`identified_only` default, so no person profiles or user records are created. Session replay is
off, and no personal data is collected.
