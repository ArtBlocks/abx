import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span
          style={{
            fontFamily: 'var(--font-mono-face), ui-monospace, monospace',
            fontWeight: 700,
            fontSize: '1.05rem',
            letterSpacing: '-0.03em',
          }}
        >
          abx<span style={{ color: 'var(--abx-rust)' }}>.</span>
        </span>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
