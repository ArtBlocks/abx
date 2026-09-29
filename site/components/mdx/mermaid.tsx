'use client';

import { use, useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';
import styles from './mermaid.module.css';

export function Mermaid({ chart }: { chart: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return;
  return <MermaidContent chart={chart} />;
}

const cache = new Map<string, Promise<unknown>>();

function cachePromise<T>(key: string, setPromise: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached as Promise<T>;

  const promise = setPromise();
  cache.set(key, promise);
  return promise;
}

function MermaidContent({ chart }: { chart: string }) {
  const id = useId();
  const { resolvedTheme } = useTheme();
  const { default: mermaid } = use(cachePromise('mermaid', () => import('mermaid')));

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    fontFamily: 'var(--font-mono), ui-monospace, monospace',
    themeCSS: 'margin: 1.5rem auto 0;',
    theme: resolvedTheme === 'dark' ? 'dark' : 'default',
    themeVariables:
      resolvedTheme === 'dark'
        ? {
            primaryColor: '#0d1524',
            primaryTextColor: '#ffffff',
            primaryBorderColor: 'oklch(0.72 0.15 45)',
            lineColor: 'oklch(0.72 0.15 45)',
            secondaryColor: '#030812',
            tertiaryColor: '#121a2a',
          }
        : {
            primaryColor: '#efe9dc',
            primaryTextColor: '#000000',
            primaryBorderColor: '#974020',
            lineColor: '#974020',
            secondaryColor: '#f7f5ee',
            tertiaryColor: '#ebe6d9',
          },
  });

  const { svg, bindFunctions } = use(
    cachePromise(`${chart}-${resolvedTheme}`, () => {
      return mermaid.render(id, chart.replaceAll('\\n', '\n'));
    }),
  );

  return (
    <div
      className={styles.wrap}
      ref={(container) => {
        if (container) bindFunctions?.(container);
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
