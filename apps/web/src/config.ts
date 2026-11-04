// SPDX-License-Identifier: AGPL-3.0-or-later
declare const __API_URL__: string;
declare const __TURNSTILE_SITE_KEY__: string;
declare const __BUILD__: { commit: string; date: string };

/** Product name lives in one place so forks and rebrands are a one-line change. */
export const APP_NAME = 'Ours';
/** Empty when the build has no API configured: only demo mode is available. */
export const API_URL: string = __API_URL__;
export const HAS_API = API_URL !== '';
/** Cloudflare Turnstile site key for sign-in; empty = no bot check (self-hosts, development). */
export const TURNSTILE_SITE_KEY: string = __TURNSTILE_SITE_KEY__;
/** This build: its commit (short) and build date. */
export const BUILD: { commit: string; date: string } = __BUILD__;
