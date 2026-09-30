import Link from 'next/link';
import {ArrowRight} from '@phosphor-icons/react/ssr';
import {PromptCard} from '@/components/prompt-card';
import {QUICKSTART_PROMPT} from '@/lib/quickstart';
import styles from './home.module.css';

export default function HomePage() {
  return (
    <main className={`${styles.home} [grid-area:main]`} data-layout-main="">
      <section className={styles.hero}>
        <div className={styles.heroBody}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>ABX Docs</p>
            <h1>Start building.</h1>
            <p className={styles.lede}>
              Guides and reference for the ABX protocol, CLI, agent skill, and SDK.
            </p>

            <PromptCard prompt={QUICKSTART_PROMPT} variant="hero" />

            <div className={styles.actions}>
              <Link href="/docs/using-abx/quickstart" className={styles.primaryAction}>
                Quickstart <ArrowRight aria-hidden weight="regular" />
              </Link>
              <a href="https://github.com/ArtBlocks/abx" className={styles.secondaryAction}>
                View source
              </a>
            </div>
          </div>
        </div>

        <footer className={styles.facts}>
          <span>Open source</span>
          <span>Built by the team at Art Blocks</span>
        </footer>
      </section>
    </main>
  );
}
