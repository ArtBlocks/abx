import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { GithubLogo } from '@phosphor-icons/react/ssr';
import { AbxMark } from '@/components/abx-mark';
import { gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    links: [
      {
        type: 'icon',
        url: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
        text: 'GitHub',
        label: 'GitHub',
        icon: <GithubLogo />,
        external: true,
      },
    ],
    nav: {
      title: (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            color: 'var(--page-ink)',
          }}
        >
          <span className="sr-only">ABX</span>
          <AbxMark width={45} height={24} />
        </span>
      ),
    },
  };
}
