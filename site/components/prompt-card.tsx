'use client';

import {Check, Copy} from 'lucide-react';
import {useState} from 'react';

export function PromptCard({prompt}: {prompt: string}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="prompt-card">
      <div className="prompt-card-label">One prompt</div>
      <p>{prompt}</p>
      <button type="button" onClick={copy} aria-label="Copy quickstart prompt">
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
