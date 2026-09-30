import {AbxMark} from '@/components/abx-mark';
import styles from './brand-kit.module.css';

type Download = {
  href: string;
  label: string;
};

function Downloads({items}: {items: Download[]}) {
  return (
    <div className={styles.downloads}>
      {items.map((item) => (
        <a key={item.href} href={item.href} download>
          {item.label}
        </a>
      ))}
    </div>
  );
}

export function BrandKitAssets() {
  return (
    <div className={styles.assets}>
      <article className={styles.assetCard}>
        <div className={styles.markPreview} aria-label="ABX mark shown on light and dark backgrounds">
          <span className={styles.markLight}>
            <AbxMark />
          </span>
          <span className={styles.markDark}>
            <AbxMark />
          </span>
        </div>
        <div className={styles.assetBody}>
          <div>
            <h3>ABX mark</h3>
            <p>The connected mark. Use the SVG whenever possible.</p>
          </div>
          <Downloads
            items={[
              {href: '/brand/abx-mark.svg', label: 'SVG'},
              {href: '/brand/abx-mark-black.png', label: 'PNG · black'},
              {href: '/brand/abx-mark-white.png', label: 'PNG · white'},
            ]}
          />
        </div>
      </article>

      <article className={styles.assetCard}>
        <div className={styles.badgePreview}>
          <img src="/brand/built-on-abx-light.svg" alt="Built on ABX, light" width="180" height="56" />
          <img src="/brand/built-on-abx-dark.svg" alt="Built on ABX, dark" width="180" height="56" />
        </div>
        <div className={styles.assetBody}>
          <div>
            <h3>Built on ABX</h3>
            <p>A compact credit for project sites, mint pages, and developer tools.</p>
          </div>
          <Downloads
            items={[
              {href: '/brand/built-on-abx-light.svg', label: 'SVG · light'},
              {href: '/brand/built-on-abx-dark.svg', label: 'SVG · dark'},
              {href: '/brand/built-on-abx-light.png', label: 'PNG · light'},
              {href: '/brand/built-on-abx-dark.png', label: 'PNG · dark'},
            ]}
          />
        </div>
      </article>
    </div>
  );
}

const colors = [
  {name: 'Paper', value: '#F7F5EE', className: styles.paper},
  {name: 'Ink', value: '#000000', className: styles.ink},
  {name: 'Night', value: '#030812', className: styles.night},
  {name: 'Rust', value: '#974020', className: styles.rust},
];

export function BrandPalette() {
  return (
    <div className={styles.palette}>
      {colors.map((color) => (
        <div className={styles.swatch} key={color.value}>
          <span className={`${styles.color} ${color.className}`} aria-hidden />
          <span>
            <strong>{color.name}</strong>
            <code>{color.value}</code>
          </span>
        </div>
      ))}
    </div>
  );
}
