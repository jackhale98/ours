// SPDX-License-Identifier: AGPL-3.0-or-later
declare const __API_URL__: string;

/** Product name lives in one place so forks and rebrands are a one-line change. */
export const APP_NAME = 'Ours';
/** Empty when the build has no API configured: only demo mode is available. */
export const API_URL: string = __API_URL__;
export const HAS_API = API_URL !== '';
