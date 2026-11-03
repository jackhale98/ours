// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Configuration via environment (see docs/SELF_HOSTING.md):
 *   OURS_BASE     base path, e.g. "/ours/" for a GitHub Pages project site, "/" for a custom domain
 *   VITE_API_URL  origin of the API Worker, e.g. "https://ours-api.example.workers.dev"
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.OURS_BASE ?? '/';
  const api = env.VITE_API_URL ?? 'http://localhost:8787';
  const apiOrigin = new URL(api).origin;

  // GitHub Pages cannot send headers, so the CSP lives in a meta tag.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${apiOrigin}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');

  const cspPlugin: Plugin = {
    name: 'ours-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('%OURS_CSP%', csp),
  };
  const devCspPlugin: Plugin = {
    name: 'ours-csp-dev',
    apply: 'serve',
    // Vite's dev client needs a websocket and inline styles; keep dev permissive.
    transformIndexHtml: (html) =>
      html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, ''),
  };

  return {
    base,
    plugins: [preact(), cspPlugin, devCspPlugin],
    define: { __API_URL__: JSON.stringify(api) },
    build: {
      target: 'es2022',
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          main: resolve(import.meta.dirname, 'index.html'),
          join: resolve(import.meta.dirname, 'join/index.html'),
        },
      },
    },
  };
});
