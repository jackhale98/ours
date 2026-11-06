// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shared UI pieces: icons, ownership markers, avatars, toast, sheet. */
import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { SHAPE_NAMES, shapeOf } from './appearance';
import { nameOf, type Slot } from './model';

const PATHS = {
  lock: '<rect x="5" y="11" width="14" height="9.5" rx="2.2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  heart:
    '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.6.7-4.1 3.9 1 5.6-5-2.8-5 2.8 1-5.6-4.1-3.9 5.6-.7z"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8.5 3v4M15.5 3v4"/>',
  list: '<path d="M9.5 6.5h10.5M9.5 12h10.5M9.5 17.5h10.5"/><path d="M4 6.5l1.2 1.2L7.2 5.5M4 12l1.2 1.2L7.2 11"/><circle cx="5.5" cy="17.5" r="1.2"/>',
  rings: '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>',
  shield:
    '<path d="M12 3l7.5 3v5.5c0 4.6-3.1 7.9-7.5 9.5-4.4-1.6-7.5-4.9-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/>',
  chat: '<path d="M4.5 5.5h15v10h-9.5l-5.5 4z"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.2"/>',
  repeat:
    '<path d="M17 3l3 3-3 3"/><path d="M4 12v-1.5A4.5 4.5 0 0 1 8.5 6H20"/><path d="M7 21l-3-3 3-3"/><path d="M20 12v1.5a4.5 4.5 0 0 1-4.5 4.5H4"/>',
  shuffle:
    '<path d="M3 7h3.5c4.5 0 6 10 10.5 10H21"/><path d="M18 14l3 3-3 3"/><path d="M3 17h3.5c1.4 0 2.5-1 3.4-2.4"/><path d="M13.6 9.4C14.6 8 15.6 7 17 7h4"/><path d="M18 4l3 3-3 3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  send: '<path d="M5 12h12M12 6l6 6-6 6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="1.5"/><path d="M2.5 19h19"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  prev: '<path d="M14.5 6l-6 6 6 6"/>',
  next: '<path d="M9.5 6l6 6-6 6"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  inbox:
    '<path d="M3.5 13.5 6 5.5h12l2.5 8v5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  flag: '<path d="M6 21V4.5M6 5h11l-2.5 4 2.5 4H6"/>',
  down: '<path d="M6 9.5l6 6 6-6"/>',
  up: '<path d="M6 14.5l6-6 6 6"/>',
  archive:
    '<rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5.5 8.5V18a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5M10 12.5h4"/>',
  move: '<path d="M4 12h13M13 7l5 5-5 5"/><path d="M20 5v14"/>',
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      class="ic"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}

export const colorVar = (slot: Slot) => (slot === 'a' ? 'var(--person-a)' : 'var(--person-b)');

/**
 * Ownership marker: person A and person B in their colours and shapes (each
 * picked in Settings → Appearance), ours = both overlapping;
 * filled = confirmed, outline = tentative, hatched = private ("busy").
 */
export function Marker({ owner, mode }: { owner: Slot | 'both'; mode?: 'dash' | 'busy' }) {
  const cls = `mk${owner === 'both' ? ' mk-ours' : ''}${mode ? ` ${mode}` : ''}`;
  return owner === 'both' ? (
    <span class={cls} aria-hidden="true">
      <i class="a" />
      <i class="b" />
    </span>
  ) : (
    <span class={cls} aria-hidden="true">
      <i class={owner === 'a' ? 'solo a' : 'solo b'} />
    </span>
  );
}

/** " (square)" when your shapes differ, so the key says how to tell you apart. */
const shapeWord = (slot: Slot) =>
  shapeOf('a') === shapeOf('b') ? '' : ` (${SHAPE_NAMES[shapeOf(slot)].toLowerCase()})`;

/** Explains the markers in words; shown under the agenda. */
export function MarkerKey({ names }: { names: Record<Slot, string> }) {
  const items: [ComponentChildren, string][] = [
    [<Marker owner="a" key="a" />, `${names.a}’s plan${shapeWord('a')}`],
    [<Marker owner="b" key="b" />, `${names.b}’s plan${shapeWord('b')}`],
    [<Marker owner="both" key="both" />, 'Ours, together'],
    [<Marker owner="both" mode="dash" key="dash" />, 'Tentative: waiting for a yes'],
    [<Marker owner="b" mode="busy" key="busy" />, 'Private: details hidden'],
  ];
  return (
    <details class="key">
      <summary>What the marks mean</summary>
      <ul>
        {items.map(([mark, label]) => (
          <li key={label}>
            {mark}
            {label}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function Avatar({ slot, small }: { slot: Slot; small?: boolean }) {
  return (
    <span class={`av${small ? ' sm' : ''}`} style={{ '--c': colorVar(slot) }} aria-hidden="true">
      {nameOf(slot).charAt(0)}
    </span>
  );
}

/* ---------- toast ---------- */

interface Toast {
  id: number;
  message: string;
  undo?: () => void;
}
export const toastState = signal<Toast | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, undo?: () => void): void {
  clearTimeout(toastTimer);
  toastState.value = { id: Date.now(), message, ...(undo ? { undo } : {}) };
  toastTimer = setTimeout(() => {
    toastState.value = null;
  }, 5000);
}

export function ToastHost() {
  const t = toastState.value;
  // The live region stays mounted so screen readers announce changes.
  return (
    <div class="toast-host" role="status" aria-live="polite">
      {t && (
        <div class="toast" key={t.id}>
          <span>{t.message}</span>
          {t.undo && (
            <button
              type="button"
              onClick={() => {
                t.undo?.();
                toastState.value = null;
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- sheet ---------- */

/**
 * Modal sheet on the native <dialog>: focus is trapped by the browser,
 * Escape closes it, and focus returns to the element that opened it.
 */
/**
 * The control a person last pressed. Safari does not focus buttons on click,
 * so document.activeElement alone cannot tell us where to return focus.
 */
let lastPressed: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  const remember = (e: Event) => {
    const el = (e.target as Element | null)?.closest?.<HTMLElement>('button, a[href], [tabindex]');
    if (el && !el.closest('dialog')) lastPressed = el;
  };
  document.addEventListener('pointerdown', remember, true);
  document.addEventListener('keydown', remember, true);
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])';

/*
 * While a sheet is open the page behind it stays put. A modal <dialog> makes
 * the page inert but doesn't stop it scrolling. The page's overflow is
 * hidden (it stays exactly where it was, nothing moves), and on iPhones,
 * which scroll it anyway on a drag, a drag that starts outside the open sheet
 * is stopped; the sheet's own scrolling never chains to the page
 * (overscroll-behavior). Counted, so sheets opened from sheets nest.
 */
let scrollLocks = 0;
const stopOutside = (e: TouchEvent) => {
  if (!(e.target instanceof Element) || !e.target.closest('dialog[open]')) e.preventDefault();
};
function lockScroll(): void {
  if (scrollLocks++ > 0) return;
  document.documentElement.classList.add('locked');
  document.addEventListener('touchmove', stopOutside, { passive: false });
}
function unlockScroll(): void {
  if (--scrollLocks > 0) return;
  scrollLocks = 0;
  document.documentElement.classList.remove('locked');
  document.removeEventListener('touchmove', stopOutside);
}

/**
 * Whether opening a sheet should put the cursor in its text field. Not on
 * touch screens when the sheet is for looking or changing details: the
 * keyboard would cover it. Sheets for typing (quick add, new list) always do.
 */
export const typeFirst = () => {
  try {
    return !matchMedia('(pointer: coarse)').matches;
  } catch {
    return true;
  }
};

export function Sheet({
  labelledBy,
  onClose,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Layout effect: open the modal and start listening before the browser paints,
  // so there is no moment where the sheet is visible but Escape does nothing.
  useLayoutEffect(() => {
    const dialog = ref.current;
    const active = document.activeElement as HTMLElement | null;
    const opener = active && active !== document.body ? active : lastPressed;
    if (dialog && !dialog.open) dialog.showModal();
    lockScroll();
    // Always start focus inside the sheet: the marked field, else the first control.
    const first =
      dialog?.querySelector<HTMLElement>('[data-autofocus]') ??
      dialog?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    // Escape anywhere closes the sheet, even before focus has moved into it
    // (Safari doesn't focus a clicked button, so a quick Escape lands on <body>).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Close the modal first: while it is open the rest of the page is inert and can't take focus.
      if (dialog?.open) dialog.close();
      unlockScroll();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Escape and the Close button cover keyboard users
    <dialog
      ref={ref}
      class="sheet"
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // backdrop click
      }}
    >
      <div class="sheet-body">{children}</div>
    </dialog>
  );
}

export function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" class="iconbtn" onClick={onClose} aria-label="Close">
      <Icon name="x" />
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label class="sw">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        aria-checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span class="track" />
      <span class="sw-t">
        {label}
        <small>{hint}</small>
      </span>
    </label>
  );
}
