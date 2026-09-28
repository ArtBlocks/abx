const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

// Imported dynamically to keep posthog-js out of the eager bundle every page loads. Without a key
// the site stays uninstrumented, so local builds and forks neither emit events nor ship the client.
if (key) {
  import('posthog-js')
    .then(({ default: posthog }) => {
      posthog.init(key, {
        api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
        // `defaults` is what sets capture_pageview to 'history_change'. Without it posthog-js
        // records only the first load, and navigation between doc pages goes uncounted.
        defaults: '2026-08-30',
      });
    })
    .catch((error: unknown) => {
      console.error('PostHog initialisation failed', error);
    });
}
