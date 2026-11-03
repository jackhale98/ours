// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Configuration via environment (see docs/SELF_HOSTING.md):
 *   OURS_BASE     base path, e.g. "/ours/" for a GitHub Pages project site, "/" for a custom domain
 *   VITE_API_URL  origin of the API Worker, e.g. "https://ours-api.example.workers.dev".
 *                 Empty or unset in production builds = demo-only site (no API, connect-src 'self').
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.OURS_BASE ?? '/';
  const api = env.VITE_API_URL || (mode === 'development' ? 'http://localhost:8787' : '');
  const apiOrigin = api ? new URL(api).origin : '';
  // Optional bot check on sign-in (SELF_HOSTING.md). Widens the CSP for
  // Cloudflare's challenge host only when a site key is configured.
  const turnstileKey = env.VITE_TURNSTILE_SITE_KEY ?? '';
  const challenges = turnstileKey ? ' https://challenges.cloudflare.com' : '';

  // GitHub Pages cannot send headers, so the CSP lives in a meta tag.
  const csp = [
    "default-src 'self'",
    `script-src 'self'${challenges}`,
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ''}${challenges}`,
    ...(turnstileKey ? [`frame-src${challenges}`] : []),
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');

  // Operator details for the legal pages (docs/SELF_HOSTING.md). Until they are
  // set, the pages say plainly that this is a preview instance.
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const operator = env.OURS_OPERATOR ?? '';
  const contact = env.OURS_CONTACT ?? '';
  const legal: Record<string, string> = {
    '%OURS_OPERATOR%': operator ? esc(operator) : 'the project maintainers',
    '%OURS_CONTACT%': contact
      ? `<a href="mailto:${esc(contact)}">${esc(contact)}</a>`
      : '<a href="https://github.com/jackhale98/ours/issues">the project’s issue tracker</a>',
    '%OURS_GOVERNING_LAW%': esc(env.OURS_GOVERNING_LAW || 'the law of the operator’s home country'),
    '%OURS_REGION%': esc(env.OURS_REGION || 'data stored in the EU'),
    '%OURS_EMAIL_PROVIDER%': esc(env.OURS_EMAIL_PROVIDER || 'named here once accounts open'),
    '%OURS_LEGAL_DATE%': esc(env.OURS_LEGAL_DATE || '3 November 2026'),
    '%OURS_DRAFT_NOTE%': operator
      ? ''
      : '      <p class="note"><strong>Preview instance.</strong> Accounts are not open here yet; the demo keeps everything in your browser and sends nothing to a server.</p>',
  };

  const cspPlugin: Plugin = {
    name: 'ours-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('%OURS_CSP%', csp),
  };
  const legalPlugin: Plugin = {
    name: 'ours-legal',
    transformIndexHtml: (html) => html.replace(/%OURS_[A-Z_]+%/g, (k) => legal[k] ?? k),
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
    plugins: [
      preact(),
      cspPlugin,
      devCspPlugin,
      legalPlugin,
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        injectRegister: false,
        manifestFilename: 'manifest.webmanifest',
        includeAssets: ['icon.svg', 'apple-touch-icon.png'],
        manifest: {
          id: base,
          name: 'Ours',
          short_name: 'Ours',
          description: 'A private, end-to-end encrypted planner for two.',
          start_url: `${base}#plan`,
          scope: base,
          display: 'standalone',
          background_color: '#f4f6f5',
          theme_color: '#f4f6f5',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: 'icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
            { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
          ],
        },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,woff2,svg,png,webmanifest}'],
        },
        devOptions: { enabled: false },
      }),
    ],
    define: {
      __API_URL__: JSON.stringify(api),
      __TURNSTILE_SITE_KEY__: JSON.stringify(turnstileKey),
    },
    build: {
      target: 'es2022',
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          main: resolve(import.meta.dirname, 'index.html'),
          join: resolve(import.meta.dirname, 'join/index.html'),
          privacy: resolve(import.meta.dirname, 'legal/privacy/index.html'),
          terms: resolve(import.meta.dirname, 'legal/terms/index.html'),
          accessibility: resolve(import.meta.dirname, 'legal/accessibility/index.html'),
        },
      },
    },
  };
});
