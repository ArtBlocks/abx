import Link from 'next/link';
import {ArrowRight} from 'lucide-react';
import {PromptCard} from '@/components/prompt-card';
import {QUICKSTART_PROMPT} from '@/lib/quickstart';
import styles from './home.module.css';

export default function HomePage() {
  return (
    <main className={styles.home}>
      <section className={styles.hero}>
        <div className={styles.sky} aria-hidden>
          <span className={styles.sun} />
          <span className={styles.horizon} />
        </div>

        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>ABX / OPEN PROTOCOL</p>
          <h1>Put it onchain.</h1>
          <p className={styles.lede}>
            Create, operate, and serve digital work from one open protocol.
          </p>

          <PromptCard prompt={QUICKSTART_PROMPT} />

          <div className={styles.actions}>
            <Link href="/docs/using-abx/quickstart" className={styles.primaryAction}>
              Quickstart <ArrowRight aria-hidden />
            </Link>
            <a href="https://github.com/ArtBlocks/abx" className={styles.secondaryAction}>
              View source
            </a>
          </div>
        </div>
      </section>

      <footer className={styles.facts}>
        <span>Open source</span>
        <span>EVM</span>
        <span>Built by the team at Art Blocks</span>
      </footer>
    </main>
  );
}
