# Review 0010: Lighthouse

Date: 2026-11-05 · Build: after reviews 0008 and 0009 were addressed · Tool: Lighthouse 12, headless Chromium, `vite preview` of the production build, a fresh profile each run (so every app run seeds the demo).

## Scores

Phone uses Lighthouse's default mobile emulation (slow 4G, 4× CPU slowdown);
desktop uses `--preset=desktop`.

| Page | Phone (perf · a11y · best practices · SEO) | Desktop |
|---|---|---|
| Landing `/` | 100 · 100 · 100 · 100 | 100 · 100 · 100 · 100 |
| Plan `/#plan` | 90 · 100 · 100 · 100 | 100 · 100 · 100 · 100 |
| Lists `/#lists` | 95 · 100 · 100 · 100 | 100 · 100 · 100 · 100 |
| Check-in `/#checkin` | 92 · 100 · 100 · 100 | 100 · 100 · 100 · 100 |
| Privacy `/#privacy` | 93 · 100 · 100 · 100 | 100 · 100 · 100 · 100 |
| Privacy policy `/legal/privacy/` | 100 · 100 · 100 · 100 | 100 · 100 · 100 · 100 |

Phone metrics on the app pages: FCP about 1.6 s, LCP 2.4 to 2.65 s,
TBT 150 to 330 ms, CLS at most 0.014. Desktop: LCP under 0.65 s, TBT 0.

## Fixed in this pass

- **SEO 91 → 100:** there was no `robots.txt`, so the single-page fallback
  answered with the app's HTML. Added `robots.txt` and a sitemap of the public
  pages.
- **SEO 82 → 100 on the legal pages:** they had no meta description.
- **Heading font preloaded:** the LCP element on the app pages is the `<h1>`,
  set in Bricolage Grotesque, which was only discovered after the stylesheet.
  It is now preloaded with the body font.

## What's left, and why it stays

- **Phone LCP of about 2.5 s on a cold start.** The app's code (about 130 KB
  compressed, across a few chunks) loads in a third round trip, after `main`
  decides the URL is an app route. Preloading it from `index.html` would add
  that download to every landing page visit. Installed or returning users load
  from the service worker's precache, so this applies to the first visit only.
- **TBT of 150 to 330 ms.** Mostly the demo seeding and the first render under
  a 4× CPU slowdown; a signed-in account doesn't seed. Seeding already runs in
  its own task.
- **Render-blocking stylesheet (about 5 KB compressed).** Inlining it would need
  a hash in the Content-Security-Policy's `style-src`; not worth weakening or
  complicating the policy for the estimated gain.

## How to run it again

```sh
pnpm build && pnpm --filter @ours/web exec vite preview --port 4173
npx lighthouse@12 http://localhost:4173/#plan --chrome-flags="--headless=new"
npx lighthouse@12 http://localhost:4173/#plan --preset=desktop --chrome-flags="--headless=new"
```
