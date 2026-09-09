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
    fontFamily: 'var(--font-mono-face), ui-monospace, monospace',
    themeCSS: 'margin: 1.5rem auto 0;',
    theme: resolvedTheme === 'dark' ? 'dark' : 'default',
    themeVariables:
      resolvedTheme === 'dark'
        ? {
            primaryColor: '#2b2119',
            primaryTextColor: '#f0e5d3',
            primaryBorderColor: '#dc7958',
            lineColor: '#dc7958',
            secondaryColor: '#17130f',
            tertiaryColor: '#201a15',
          }
        : {
            primaryColor: '#efe0cc',
            primaryTextColor: '#211c16',
            primaryBorderColor: '#a33e25',
            lineColor: '#a33e25',
            secondaryColor: '#f8f2e8',
            tertiaryColor: '#f2eadc',
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
