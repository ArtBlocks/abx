'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * A monospace address with a copy button, used in the deployments table where every row
 * is a value someone is about to paste into an .env file or a --factory/--renderer flag.
 */
export function CopyAddress({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(children);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      className="not-prose inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-secondary px-2 py-0.5 font-mono text-[0.85em] text-fd-secondary-foreground transition-colors hover:bg-fd-accent"
      title="Copy address"
    >
      <span>{children}</span>
      {copied ? (
        <Check size={12} className="shrink-0" style={{ color: 'var(--abx-ok)' }} />
      ) : (
        <Copy size={12} className="shrink-0 opacity-50" />
      )}
    </button>
  );
}
