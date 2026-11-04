// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A recovery phrase on screen: the 12 numbered words, and a button that
 * copies them all at once (space-separated, the form every restore screen
 * accepts), for pasting into a password manager.
 *
 * Copying is a choice, not the default: anything on the clipboard can be read
 * by other apps, and some systems sync it to other devices. The note under
 * the button says so plainly.
 */
import { useEffect, useState } from 'preact/hooks';
import { Icon, toast } from './ui';

export function PhraseWords({ words, label }: { words: string[]; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 4000);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(words.join(' '));
      setCopied(true);
      toast(`Copied all ${words.length} words. Paste them into your password manager.`);
    } catch {
      toast('Couldn’t copy here. Write the words down, or select them and copy.');
    }
  };

  return (
    <div class="phrase">
      <ol class="words" aria-label={label}>
        {words.map((w, i) => (
          <li key={`${i}-${w}`}>{w}</li>
        ))}
      </ol>
      <div class="phrase-copy">
        <button type="button" class="btn sm" onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} size={15} />
          {copied ? 'Copied' : `Copy all ${words.length} words`}
        </button>
        <p class="small muted">
          Best pasted straight into a password manager. Other apps can read what you copy, and some
          phones and computers sync it to your other devices.
        </p>
      </div>
    </div>
  );
}
