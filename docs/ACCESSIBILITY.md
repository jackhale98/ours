# Accessibility

Target: WCAG 2.2 level AA, plus colour-blind-safe design (colours that stay distinct under colour-vision simulations, with shapes available). The public statement is at `/legal/accessibility/`.

## Checked automatically on every change

| Check | Where |
|---|---|
| axe (WCAG 2.0/2.1/2.2 A and AA, best practice) on the landing page, every app view (Plan, Lists, Check-in, Privacy, calendars) and the legal pages, in light and dark | `apps/web/e2e/*.spec.ts` |
| Chromium and WebKit, desktop and phone viewports | `apps/web/playwright.config.ts` |
| Colour contrast of every text/background token pair (56), in both themes | `scripts/check-contrast.mjs` |
| The default pair of colours stays distinguishable under six colour-vision simulations (protanopia, deuteranopia, tritanopia and their anomalous forms; ΔE ≥ 10), and ownership is also given in words (screen-reader text, the marker key, avatars with initials). Each person picks a colour from a palette checked the same way (`check:contrast` covers every colour) and a marker shape (circle, square or diamond) in Privacy → Appearance; the choice is shared. The two can't pick the same colour, and if the pair could be confused under a colour-vision simulation while their shapes match, the app suggests different shapes | `scripts/check-contrast.mjs`, `MarkerKey` |
| Keyboard: quick add with `N`, Escape closes sheets and returns focus to what opened them, focus starts inside each sheet, skip link | `apps/web/e2e/demo.spec.ts` |
| Lighthouse accessibility score in CI (demo mode) | `lighthouserc.json` |
| Touch targets of at least 44 px (`--tap`) | design tokens |
| Reduced motion turns off animation and smooth scrolling | `styles/base.css` |

## Manual pass (before each release)

Automated tests can't judge whether something makes sense when heard. Do these on real devices and record the result below:

1. **Keyboard only** (desktop browser): sign in, create a space, add a plan, propose one, answer one, add a list item, finish a check-in, change a privacy setting, export. Focus must always be visible and never trapped.
2. **VoiceOver on iPhone** (installed PWA) and **TalkBack on Android**: the same flows. Plans must be announced with whose they are and whether they're tentative or private; toasts must be read; the safety code must be read as digits.
3. **Zoom to 200 %** and **320 px width**: no horizontal scrolling, nothing cut off.
4. **Dark mode and high-contrast modes** (Windows contrast themes, iOS Increase Contrast).
5. **Colour filters** (iOS: Settings → Accessibility → Colour Filters): plans of each person still distinguishable.

### Results

| Date | Version | Who | Result |
|---|---|---|---|
| | | | Not yet done: needs a person with the devices. |

## Known limitations

- The week strip is a visual summary; the agenda below it carries the same information for screen readers.
- Imported calendar events keep whatever titles their source calendar uses.
- The optional Turnstile bot check on the sign-in page is Cloudflare's widget; it is designed to be accessible but is outside our control.

## Known limitation: markers by colour by default

Both people's markers are circles until someone picks shapes, because that looks cleaner. With matching shapes, a sighted user who can't tell the two colours apart has no non-colour cue at a glance, which falls short of WCAG 1.4.1 (Use of Color). Mitigations: the default pair (blue and rose) passes the colour-vision simulations; ownership is given in words in plan details, in the marker key and to screen readers; and Privacy → Appearance lets each person pick a shape, and says so when the chosen colours could be confused.
