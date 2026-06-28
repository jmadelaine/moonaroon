# CLAUDE.md — Moonaroon

Context for working on this extension with Claude Code. Read this before changing
theming logic — several non-obvious decisions here were paid for with real bugs.

## What this is

**Moonaroon** is a Manifest V3 Chrome extension that applies a coherent dark mode
to **Cybozu on `bozuman.cybozu.com`** — both **Garoon** (`/g/`, classic multi-frame
app) and **Kintone** (`/k/`, a React/styled-components app). A toolbar popup toggles
it; state lives in `chrome.storage.sync`. The content script runs at `document_start`
in **all frames** (Garoon leans heavily on iframes). The two apps stress different
things — Garoon: many `<link>` sheets, iframes, `media="print"`, already-dark header;
Kintone: CSS-in-JS, CSS custom properties named after colors. Both are covered below.

## The core idea (and what it is NOT)

We do **not** use a blind `filter: invert()` and we do **not** mutate the live
CSSOM. Instead, for every stylesheet the content script:

1. **Fetches the raw CSS text** (`fetch(link.href)`) for `<link>` sheets, or reads
   `<style>` text directly.
2. **Rewrites colors in the text** and reinjects the result as a `<style>`, then
   disables the original sheet. Inline `style="..."` attributes are handled too.

Colors are remapped by converting to HSL and **inverting only the lightness while
preserving hue + saturation**, so the Cybozu blue stays blue and alert red stays
red. Only **neutrals and pale tints** are touched; **saturated colors pass through
untouched** (`remapRgb` returns `null`). Neutrals are tinted toward a charcoal
hue rather than flat gray.

Why fetch-and-reinject instead of editing the CSSOM in place:

- `sheet.cssRules` throws `SecurityError` on cross-origin sheets; `fetch` (with
  the right `host_permissions`) does not.
- It's deterministic — each sheet is transformed exactly once, avoiding the
  double-remap / feedback-loop bugs that plagued the CSSOM approach.

## File map

| File                                    | Role                                                                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                         | MV3 config. `all_frames: true`, `host_permissions` for `bozuman.cybozu.com` + `static.cybozu.com`.                                                                                                                                                                               |
| `content.js`                            | All theming logic (see below).                                                                                                                                                                                                                                                   |
| `popup.html` / `popup.css` / `popup.js` | Toolbar toggle. Palette mirrors the page charcoal neutrals. The switch knob is `moon.svg`; "on" lights the track white with a glow; the label text itself reports state ("Dark mode is on/off") — there's no separate status line. (`--accent` is defined but currently unused.) |
| `icons/`                                | `icon{16,32,48,128}.png` (downscale the 128 master with `sips`) + `moon.svg` used in the popup.                                                                                                                                                                                  |

## content.js tour

Color math & mapping

- `rgbToHsl` / `hslToRgb` — conversions.
- `remapRgb(r,g,b)` — **the heart of the theme.** Neutrals (`saturation < 0.12`)
  → lightness inverted onto a charcoal hue. Pale tints (`l > 0.8`) → dark tinted
  surface. Everything else → `null` (left as-is). Tunables: `NEUTRAL_HUE`,
  `NEUTRAL_SAT`.
- `remapColors(value)` — replaces hex / `rgb()` tokens (`COLOR_RE`) and **named**
  CSS neutrals (`NAMED` / `NAMED_RE`, e.g. `gray`, `white`) in a value string.

CSS text transform

- `transformCss(text, baseHref)` — absolutizes `@import` urls, then remaps colors
  **only inside `{ ... }` declaration blocks** (so a selector like `#abc` is never
  mistaken for a color).
- `remapDecls(body, baseHref)` — within a block: absolutize + protect `url(...)`,
  protect quoted strings (`content:`, `font-family:`) and `box-shadow`/`text-shadow`,
  then remap the rest. Protected spans are stashed behind placeholders.

Apply / observe / remove

- `applyDark()` — injects the base style (canvas background + `OVERRIDES`), runs
  `scan()`, and starts a `MutationObserver` for dynamically added sheets/styles/
  inline styles. Also re-scans on `DOMContentLoaded`, `load`, and a few timers.
- `scan()` / `processLink` / `processStyleEl` / `processInlineStyles` — do the work.
- `withPaused(fn)` — runs DOM-mutating work with the observer disconnected +
  `takeRecords()` so our own writes don't feed back in.
- `removeDark()` — removes injected styles, re-enables originals, restores inline
  styles. Toggling off is fully reversible and live.

## Hard-won gotchas (don't relearn these)

1. **Test over HTTP, never `file://`.** Chrome treats every `file://` resource as a
   unique opaque origin, so cross-file CSS reads throw `SecurityError` and `fetch`
   behaves differently. A `file://` render will look "mostly themed" via the base
   background alone and **lie to you**. Use a local HTTP server (below).

2. **Anything we inject must be marked `GEN` (`data-moonaroon-gen`)** so the remapper
   never re-processes it. Forgetting this on the base style caused it to invert its
   own `#191919` into a light `#dddddd` and wash the page out.

3. **Never double-transform a sheet.** The remap is not idempotent (`#fff` → dark →
   light). Each `<link>`/`<style>` is guarded with `PROCESSED` and transformed once.

3a. **Never re-assign a `<style>`'s `textContent` unless it changed.** CSS-in-JS
(styled-components, Emotion — e.g. Kintone's `sc-*`/hashed classes) injects rules
via the CSSOM (`insertRule`) and keeps `textContent` empty. Re-assigning
`textContent`, _even to the same empty string_, makes the browser re-parse the
element and WIPE the injected rules, destroying layout. `processStyleEl` bails when
`transformCss(orig) === orig`. Consequence: CSS-in-JS **colors aren't themed** (the
rules live in the CSSOM, not in text we can rewrite) — those elements keep their
original colors. Theming them would require walking `style.sheet.cssRules` and
rewriting color props in place (and handling rules styled-components appends later,
which fire no DOM mutation). Not done yet.

3b. **Preserve the `<link media="...">` scope when reinjecting.** A reinjected
`<style>` defaults to `media="all"`, so a `media="print"` sheet would suddenly
apply on screen. Garoon's `print.css` has `.cloudHeader-grn{position:static
   !important}` — leaking it on screen overrode the header's runtime `position:fixed`
and broke the layout. `processLink` copies `link.media` onto the `<style>`. (Cascade
ORDER is already preserved by inserting each replacement right after its own link,
so order-dependent rules resolve the same — media was the gap.)

4. **Color rewriting is confined to declaration blocks.** Doing a naive global
   replace corrupts id selectors that look like hex (`#abc`, `#dad`). Keep new color
   logic inside `remapDecls`, not loose over the whole file.

4b. **Named-color matching must not reach inside identifiers.** `NAMED_RE` uses
`(?<![\w-])…(?![\w-])`, NOT `\b`. `\b` treats `-` as a boundary, so it matches the
`gray` inside CSS custom properties like `--c-gray` or `var(--…-border-gray)` —
corrupting the reference. In Kintone that broke `border:1px solid
   var(--component-color-border-gray)`, making the border invalid and reflowing the
header (search box / button moved). The transform must only ever change color
_values_, never identifiers/property names. If you add keyword matching, keep the
no-adjacent-`[\w-]` guard.

5. **Protect `url(...)`, quoted strings, and shadows.** Data-URI SVGs embed colors;
   `content`/`font-family` may contain color words; shadows should stay dark (a
   light shadow becomes a white glow). These are stashed before remapping behind
   placeholders delimited by Private-Use Unicode chars (`U+E000` / `U+E001`,
   written as `\uE000`/`\uE001` escapes in the source) — chosen because they
   can't occur in CSS. Keep delimiters out of the normal text range so they never
   collide with stylesheet content; do NOT use NUL bytes (they make the file read
   as binary to `git`/`grep`).

6. **Already-dark elements get flipped the wrong way.** Garoon styles some elements
   dark in its _light_ theme (e.g. `.cloudHeader-grn` = `#4b4a4a` with light text).
   Lightness inversion turns those _light_ — wrong. These can't be auto-detected
   from a color alone (dark text _should_ invert to light; a dark background should
   not), so they're handled by hand in the `OVERRIDES` block. Use **doubled-class
   selectors** (`.x.x`) there to win specificity against Garoon's own `!important`.

7. **Native form controls & scrollbars have no CSS color** — the browser draws them
   from UA defaults the remapper never sees. `OVERRIDES` forces inputs/textarea/select
   to a dark field with light text, sets `color-scheme: dark` + `scrollbar-color`, and
   adds `::-webkit-scrollbar` rules so native scrollbars are charcoal.

7b. **Inline-style remapping uses longhands only.** `processInlineStyles` must not
read both a shorthand and its longhand (`background` + `background-color`,
`border-color` + `border-*-color`): remapping the shorthand sets the longhand, then
reading the longhand and remapping again double-inverts it (`#fff` → dark → light).
It reads only longhands, which already reflect whatever a shorthand set. (The
stylesheet path doesn't have this problem — `transformCss` rewrites each declaration
block's text once.)

8. **Background _images_ with baked-in light colors are not touched** — there's no
   color token to remap. Those would need a targeted `filter` rule.

## How to test (the reliable harness)

There is no automated test suite; verification is manual via headless Chrome.

Unit-test the transform in Node (it has no DOM/`chrome` deps once sliced off):

```js
// strip the runtime half, import the pure functions
let src = fs
  .readFileSync("content.js", "utf8")
  .replace(
    /\/\/ -+\n\/\/ Apply \/ remove[\s\S]*$/,
    "module.exports={transformCss,remapColors,remapRgb};",
  );
```

Then assert: `#fff` → charcoal, brand colors preserved, `#abc{}` selector intact,
`url()`/strings untouched.

Render-test against a **real saved page over HTTP** (Garoon or Kintone):

1. Save a logged-in page ("Save Page As → Web Page, Complete"). **Then COPY the
   capture to a throwaway dir and test there — never generate test files inside the
   original capture folder.** (A cleanup glob there once deleted the original
   `garoon.html`; `rm` does not go to Trash.) The captures are the developer's own
   and are **not** committed to the repo.
2. `cd <copy> && python3 -m http.server 8731`
3. Build a test HTML: strip the page's own `<script>`s (they hang headless), inject
   `content.js` (minus the `chrome.storage` wiring) with `applyDark()` at the end,
   inject the same into the iframe sub-pages to simulate `all_frames`.
4. Screenshot: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
--headless --disable-gpu --window-size=1440,2200 --virtual-time-budget=9000
--screenshot=out.png "http://localhost:8731/test.html"`
5. To diagnose a specific element, inject a probe that writes
   `getComputedStyle(el).backgroundColor` into `document.title` and read it with
   `--dump-dom`.

Testing hygiene:

- **Never `pkill` Chrome** to clean up — it kills the developer's real browser
  session. A one-off `--headless` invocation uses an ephemeral profile and exits on
  its own; just let it. (`pkill -f http.server` is fine — that's only the test server.)
- Caveat: a saved page can mislead. `file://` breaks `fetch`/cross-origin (see gotcha
  1), and a page-save tool serializes CSS-in-JS into `textContent`, hiding the live
  `insertRule` behavior (gotcha 3a). Confirm anything layout-related on the live site.

## Tuning knobs

- **Overall darkness / tint:** `NEUTRAL_HUE`, `NEUTRAL_SAT`, and the lightness curve
  `0.95 - l * 0.85` in `remapRgb`. The popup palette in `popup.css` should be kept
  in sync with the values these produce.
- **Per-element fixes:** add rules to the `OVERRIDES` template literal (doubled-class
  selectors, `!important`). This is the right place for "this specific thing is still
  light/wrong" requests. It already holds: the cloud-header bar (`HEADER_BG` constant)
  and its title text, native form controls, and scrollbars (`color-scheme` +
  `::-webkit-scrollbar`).
- **Reach more colors:** extend `NAMED` for additional CSS color keywords; saturated
  ones are safe to add since `remapRgb` leaves them untouched.

## Conventions

- Plain ES (no build step, no deps). Keep `content.js` self-contained.
- Match the existing comment density — explain _why_, especially around the gotchas.
- After any change, run `node --check content.js` and do an HTTP render-test before
  claiming it works.
