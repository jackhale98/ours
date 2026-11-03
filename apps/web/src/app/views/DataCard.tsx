// SPDX-License-Identifier: AGPL-3.0-or-later
/** Privacy → Your data: export (readable, encrypted, calendar) and import. */
import { normalizePhrase } from '@ours/core/crypto';
import { useRef, useState } from 'preact/hooks';
import { isCurrentPhrase } from '../../account/session';
import {
  calendarExport,
  encryptedExport,
  ImportError,
  type ImportSummary,
  planImport,
  readableExport,
} from '../export';
import { mode } from '../model';
import { seedDemo } from '../seed';
import { today } from '../select';
import { Icon, toast } from '../ui';

function download(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Asking = { for: 'export' } | { for: 'import'; text: string } | null;

function summarise(s: ImportSummary): string {
  const parts = [
    [s.plans, 'plan'],
    [s.lists, 'list'],
    [s.items, 'list item'],
    [s.notes, 'note'],
    [s.calendars, 'calendar'],
    [s.other, 'check-in'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'nothing new';
}

export function DataCard() {
  const demo = mode.value === 'demo';
  const [asking, setAsking] = useState<Asking>(null);
  const [phrase, setPhrase] = useState('');
  const [resetArmed, setResetArmed] = useState(false);
  const [pending, setPending] = useState<{ summary: ImportSummary; apply: () => number } | null>(
    null,
  );
  const file = useRef<HTMLInputElement>(null);
  const stamp = today.value;

  const doImport = async (text: string, words?: (string | null)[]) => {
    try {
      const plan = await planImport(text, words);
      if (plan.status === 'needs-phrase') {
        setAsking({ for: 'import', text });
        return;
      }
      setAsking(null);
      setPhrase('');
      setPending({ summary: plan.summary, apply: plan.apply });
    } catch (err) {
      toast(err instanceof ImportError ? err.message : 'That file couldn’t be imported.');
    }
  };

  const submitPhrase = async (e: Event) => {
    e.preventDefault();
    const words = normalizePhrase(phrase);
    if (words.length !== 12 || words.some((w) => !w)) {
      toast('Enter all 12 words of your recovery phrase.');
      return;
    }
    if (asking?.for === 'export') {
      try {
        // A valid but mistyped phrase would make a file the real one can't open.
        if (!(await isCurrentPhrase(words))) {
          toast('Those aren’t your current recovery phrase words.');
          return;
        }
        download(`ours-backup-${stamp}.json`, 'application/json', await encryptedExport(words));
        setAsking(null);
        setPhrase('');
        toast('Encrypted backup downloaded. It opens only with this recovery phrase.');
      } catch {
        toast('Those words aren’t a valid recovery phrase.');
      }
    } else if (asking?.for === 'import') {
      await doImport(asking.text, words);
    }
  };

  return (
    <section class="card" aria-labelledby="data-h">
      <h2 class="h3" id="data-h">
        Your data
      </h2>
      <p class="d">
        Everything you can see, decrypted on this device.{' '}
        {demo
          ? 'Demo data lives only in this browser and never leaves it.'
          : 'A readable export isn’t encrypted (it includes your calendar links), so keep it somewhere safe. The encrypted backup opens only with your recovery phrase.'}
      </p>
      <div class="btnrow">
        <button
          type="button"
          class="btn sm"
          onClick={async () => {
            download(`ours-export-${stamp}.json`, 'application/json', await readableExport());
            toast('Export downloaded.');
          }}
        >
          <Icon name="download" size={15} />
          Export
        </button>
        <button
          type="button"
          class="btn sm"
          onClick={() => {
            download(`ours-${stamp}.ics`, 'text/calendar', calendarExport());
            toast('Calendar file downloaded. Import it into any calendar app.');
          }}
        >
          <Icon name="cal" size={15} />
          Calendar (.ics)
        </button>
        {!demo && (
          <button
            type="button"
            class="btn sm"
            aria-expanded={asking?.for === 'export'}
            onClick={() => setAsking(asking?.for === 'export' ? null : { for: 'export' })}
          >
            <Icon name="lock" size={15} />
            Encrypted backup
          </button>
        )}
        <button type="button" class="btn sm ghost" onClick={() => file.current?.click()}>
          Import
        </button>
        <input
          ref={file}
          class="sr"
          type="file"
          accept=".json,application/json"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="import-file"
          onChange={async (e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (!f) return;
            if (f.size > 20 * 1024 * 1024) {
              toast('That file is too big.');
              return;
            }
            await doImport(await f.text());
          }}
        />
        {demo && (
          <button
            type="button"
            class="btn sm ghost"
            onClick={() => {
              if (!resetArmed) {
                setResetArmed(true);
                return;
              }
              setResetArmed(false);
              seedDemo();
              toast('Demo data reset.');
            }}
          >
            {resetArmed ? 'Tap again to reset' : 'Reset demo data'}
          </button>
        )}
      </div>
      {pending && (
        <section class="stack gap" aria-label="Import preview">
          <p class="d">
            This file would add {summarise(pending.summary)}.
            {pending.summary.skipped
              ? ` ${pending.summary.skipped} other item${pending.summary.skipped === 1 ? ' is' : 's are'} already here, were deleted or changed here since, or belong to another space, so they’re left out.`
              : ''}
          </p>
          <div class="btnrow">
            <button
              type="button"
              class="btn sm primary"
              onClick={() => {
                const n = pending.apply();
                setPending(null);
                toast(n ? `Imported ${n} item${n === 1 ? '' : 's'}.` : 'Nothing was imported.');
              }}
            >
              Import
            </button>
            <button type="button" class="btn sm ghost" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </section>
      )}
      {asking && (
        <form class="stack gap" onSubmit={submitPhrase}>
          <div class="field">
            <label for="data-phrase">
              {asking.for === 'export'
                ? 'Your recovery phrase, to lock the backup'
                : 'The recovery phrase this backup was made with'}
            </label>
            <textarea
              id="data-phrase"
              class="txt"
              rows={3}
              autocomplete="off"
              autocapitalize="none"
              spellcheck={false}
              value={phrase}
              onInput={(e) => setPhrase(e.currentTarget.value)}
              placeholder="12 words, separated by spaces"
            />
          </div>
          <div class="btnrow">
            <button type="submit" class="btn sm primary">
              {asking.for === 'export' ? 'Download backup' : 'Import'}
            </button>
            <button
              type="button"
              class="btn sm ghost"
              onClick={() => {
                setAsking(null);
                setPhrase('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
