'use client';

import {Check, Copy} from '@phosphor-icons/react/ssr';
import {useState} from 'react';

export function PromptCard({
  prompt,
  variant = 'default',
}: {
  prompt: string;
  variant?: 'default' | 'hero';
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  const copyButton = (
    <button type="button" onClick={copy} aria-label="Copy quickstart prompt">
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );

  return (
    <div className={variant === 'hero' ? 'prompt-card prompt-card--hero' : 'prompt-card'}>
      {variant === 'hero' ? (
        <div className="prompt-card-header">
          <div className="prompt-card-label">One prompt</div>
          {copyButton}
        </div>
      ) : (
        <div className="prompt-card-label">One prompt</div>
      )}
      <p>{prompt}</p>
      {variant === 'hero' ? null : copyButton}
    </div>
  );
}
