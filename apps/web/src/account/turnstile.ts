// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cloudflare Turnstile on the sign-in screen (public-instance bot protection,
 * plan §12.1). Only when the build has a site key; then, and only on that
 * screen, the page loads Cloudflare's challenge script. Nothing else in the
 * app talks to a third party.
 */
import { TURNSTILE_SITE_KEY } from '../config';

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
      appearance?: 'always' | 'execute' | 'interaction-only';
    },
  ): string;
  reset(id?: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

function load(): Promise<TurnstileApi> {
  loading ??= new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile'));
    s.onerror = () => {
      loading = null;
      reject(new Error('The bot check couldn’t load. Check your connection and try again.'));
    };
    document.head.append(s);
  });
  return loading;
}

export const turnstileEnabled = TURNSTILE_SITE_KEY !== '';

/** Renders the check into `el`; `onToken` gets a fresh token (null when it expires). */
export async function mountTurnstile(
  el: HTMLElement,
  onToken: (token: string | null) => void,
): Promise<() => void> {
  const api = await load();
  const id = api.render(el, {
    sitekey: TURNSTILE_SITE_KEY,
    appearance: 'interaction-only',
    callback: (t) => onToken(t),
    'expired-callback': () => onToken(null),
    'error-callback': () => onToken(null),
  });
  return () => api.remove(id);
}
