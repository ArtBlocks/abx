import {contractParamString} from '@artblocks/abx-sdk';
import type {EffectContext, EffectModule, EffectOutput} from './harness.js';

/**
 * The reference `render` effect: capture the live view — the exact document a collector
 * sees — as the token's still, and collect the script's reported traits.
 *
 * Playwright is loaded **dynamically at first run** (never a static import): the
 * resolver image must never grow a browser, so the dependency exists only where
 * captures actually run (the effects image, or a laptop that ran
 * `pnpm add playwright && npx playwright install chromium`).
 *
 * Capture contract (mirrors `site/content/docs/protocol/code-projects.mdx`): wait for `abx.done()`,
 * else the project's `render.captureDelay` contract param (ms), else a default timeout.
 * Dimensions: `render.imageWidth` (default 1200 — pass a larger width for a hi-def
 * master when image is the primary display format) × `render.aspectRatio` (w/h,
 * default 1).
 *
 * Outputs (typed, per the data plane's declared-outputs rule): `image` (the still) and
 * `traits` always; `print` — a print-resolution export, the plane's reference unbound
 * artifact — only when the project sets the `render.printWidth` contract param (a second
 * capture at that width; absent ⇒ null, no artifact, no boilerplate). Because
 * `render.printWidth` is a contract param it rides tokenData, so enabling it re-addresses
 * every token — the whole collection re-renders once with the print export included.
 */
export function renderEffect(defaults: {width?: number; timeoutMs?: number} = {}): EffectModule {
  return {
    key: 'render',
    outputs: [
      // `traits` is the one BOUND output (its content stitches into `attributes`); `image` and
      // `print` are referenced — the producer holds those bytes and publishes a locator.
      {key: 'image', mimeType: 'image/png'},
      {key: 'traits', mimeType: 'application/json', bound: true},
      {key: 'print', mimeType: 'image/png'},
    ],
    async run(ctx: EffectContext): Promise<Record<string, EffectOutput | null>> {
      const width = Number(
        contractParamString(ctx.state, 'render.imageWidth') ?? defaults.width ?? 1200,
      );
      const aspect = Number(contractParamString(ctx.state, 'render.aspectRatio') ?? 1) || 1;
      const captureDelay = Number(contractParamString(ctx.state, 'render.captureDelay') ?? 0);
      const timeoutMs = captureDelay > 0 ? captureDelay : (defaults.timeoutMs ?? 10_000);
      const printWidth = Number(contractParamString(ctx.state, 'render.printWidth') ?? 0);

      const pw = await loadPlaywright();
      const browser = await pw.chromium.launch();
      try {
        const still = await capture(browser, ctx.liveViewUrl, width, Math.round(width / aspect), timeoutMs, true);
        // The print export re-runs the same deterministic document at print resolution — a
        // fresh page, so viewport-sized sketches lay out natively rather than being rescaled.
        const print =
          printWidth > 0
            ? await capture(browser, ctx.liveViewUrl, printWidth, Math.round(printWidth / aspect), timeoutMs, false)
            : null;
        return {
          image: {bytes: still.png, contentType: 'image/png'},
          traits: still.traits
            ? {bytes: new TextEncoder().encode(still.traits), contentType: 'application/json'}
            : null,
          print: print ? {bytes: print.png, contentType: 'image/png'} : null,
        };
      } finally {
        await browser.close();
      }
    },
  };
}

/** One capture: load the live view at (width, height), wait for `abx.done()` (else the timeout),
 *  screenshot — and read the script's reported traits when asked. */
async function capture(
  browser: Browser,
  liveViewUrl: string,
  width: number,
  height: number,
  timeoutMs: number,
  wantTraits: boolean,
): Promise<{png: Uint8Array; traits: string | null}> {
  const page = await browser.newPage({viewport: {width, height}});
  const resp = await page.goto(liveViewUrl, {waitUntil: 'load', timeout: 60_000});
  // Refuse to capture a failed navigation. The live view 302s to the content gateway; if that
  // ends in an error status we'd otherwise screenshot the gateway's error page and store it as
  // the "still" — a silent garbage thumbnail. The common trigger is a fresh Arweave/Turbo
  // upload that hasn't propagated yet ("hashpath cannot be resolved on this node, yet"), or a
  // dead/HTML-refusing gateway. Fail loudly instead so `abx render` reports it and nothing is stored.
  const status = resp?.status?.() ?? 0;
  if (status >= 400) {
    throw new Error(
      `live view returned HTTP ${status} (${resp?.url?.() ?? liveViewUrl}) — the content isn't servable yet. ` +
        `Arweave/Turbo uploads take time to propagate; retry the render shortly. If it persists, the gateway may be down ` +
        `or not serving HTML. Nothing was stored.`,
    );
  }
  // abx.done() is the capture point; the timeout is the fallback for scripts that never call it.
  await page
    .waitForFunction('window.abx && window.abx.__done === true', undefined, {timeout: timeoutMs})
    .catch(() => undefined);
  const png = (await page.screenshot({type: 'png'})) as Uint8Array;
  const traits = wantTraits
    ? ((await page
        .evaluate('window.abx && window.abx.__traits ? JSON.stringify(window.abx.__traits) : null')
        .catch(() => null)) as string | null)
    : null;
  return {png, traits};
}

/** Runtime-optional resolution so the workspace never hard-depends on a browser. */
async function loadPlaywright(): Promise<{chromium: {launch(): Promise<Browser>}}> {
  try {
    const {createRequire} = await import('node:module');
    const requireHere = createRequire(import.meta.url);
    return requireHere('playwright') as {chromium: {launch(): Promise<Browser>}};
  } catch {
    throw new Error(
      'playwright could not load — captures need its browsers installed where they run: ' +
        '`npx playwright install chromium` (the effects container image ships them baked in).',
    );
  }
}

interface Browser {
  newPage(opts: {viewport: {width: number; height: number}}): Promise<Page>;
  close(): Promise<void>;
}
interface Page {
  goto(url: string, opts: {waitUntil: string; timeout: number}): Promise<NavResponse | null>;
  waitForFunction(fn: string, arg: undefined, opts: {timeout: number}): Promise<unknown>;
  screenshot(opts: {type: 'png'}): Promise<Uint8Array>;
  evaluate(fn: string): Promise<unknown>;
}
interface NavResponse {
  status(): number;
  url(): string;
}
