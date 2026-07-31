# CLAUDE.md — Moonaroon

Context for working on this extension with Claude Code. Read this before changing
theming logic — several non-obvious decisions here were paid for with real bugs.

## What this is

**Moonaroon** is a Manifest V3 Chrome extension that applies a coherent dark mode
to **Cybozu on any `*.cybozu.com` host** — both **Garoon** (`/g/`, classic multi-frame
app) and **Kintone** (`/k/`, a React/styled-components app). A toolbar popup toggles
it; state lives in `chrome.storage.sync`. The content script runs at `document_start`
in **all frames** (Garoon leans heavily on iframes). The two apps stress different
things — Garoon: many `<link>` sheets, iframes, `media="print"`, already-dark header;
Kintone: CSS-in-JS, CSS custom properties named after colors. Both are covered below.

## The core idea (and what it is NOT)

We do **not** use a blind `filter: invert()`.

Colors are remapped in HSL, on three branches, with **hue always preserved** — so
Cybozu blue stays blue, alert red stays red, and calendar category colors stay
distinguishable from one another:

| input | branch | result |
| --- | --- | --- |
| neutral (`s < 0.12`) | `neutralFor` | lightness inverted onto a charcoal hue |
| pale tint (`l > 0.8`) | inline | dark tinted **surface** |
| everything else | `vividFor` | **brighter, more saturated accent** |

Neutrals are tinted toward charcoal rather than flat gray. Accents are pushed up
in saturation and lightness, then lifted further if they're still below
`MIN_CONTRAST` against the canvas — a mid-tone brand color is dull on dark
(`#0e74dd` starts at 3.8:1) and a dark one is nearly invisible (`#1c3f6e` at
1.65:1). Pale tints are deliberately *not* vivified: they're surfaces, and a
vivid surface swamps its own content.

## How stylesheets are read

For every stylesheet:

1. **`fetch` its raw text.** This is what gets past CORS — `sheet.cssRules`
   throws `SecurityError` on a cross-origin sheet.
2. **Parse it with the browser** via `new CSSStyleSheet().replaceSync(text)`. A
   sheet *we* constructed is always readable, so the parser is used purely as a
   parser. Nothing is ever adopted.
3. **Walk the parsed rule tree** and emit an **overlay** sheet holding only the
   declarations whose colors changed, inserted right after the original.

The original sheet is never disabled and never edited. Inline `style=""`
attributes are the one exception — nothing outranks them short of `!important`,
so those are rewritten in place.

**Do not go back to regexing stylesheet text.** That was the original approach
and it silently missed whatever the regexes didn't describe. Measured against the
test fixture, it failed on **native nesting** (a rule's own declarations get
skipped whenever it contains a nested block — `/\{([^{}]*)\}/g` only matches
innermost braces), **modern color syntax** (`oklch()`, `lab()`, `color()`,
space-separated `rgb()`/`hsl()`, 4- and 8-digit hex), **CSS-in-JS** (rules that
live only in the CSSOM), and it **inverted `light-dark()` backwards**. It also
needed a pile of guards against corrupting selectors and identifiers that the
parser makes unnecessary. Regexes here only ever touch a single property VALUE.

Why an overlay rather than replacing the sheet: serializing a whole parsed sheet
round-trips it through the parser, so anything Chrome rejected (legacy hacks,
vendor oddities) is silently dropped. An overlay also makes toggling off free —
no sheet was disabled and no text was edited, so removal is just deleting our
own nodes.

How the overlay wins the cascade: same selector, same at-rule nesting, same
`@layer`, same `!important`, inserted directly after the original. Equal
specificity plus later source order. Mirroring the layer matters — an unlayered
overlay would beat layered rules unconditionally, including later ones that
ought to win.

## File map

| File                                    | Role                                                                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                         | MV3 config. `all_frames: true`. `host_permissions`/`matches` are the single pattern `https://*.cybozu.com/*` — a leading `*.` matches the bare host *and* every subdomain, so it covers each tenant plus the `static.cybozu.com` CDN that sheets are fetched from. Sibling domains (`cybozu.cn`, `kintone.com`, `cybozu-dev.com`) are NOT covered; add them explicitly if needed.                                                                                                                                                                               |
| `content.js`                            | All theming logic (see below).                                                                                                                                                                                                                                                   |
| `popup.html` / `popup.css` / `popup.js` | Toolbar toggle. Palette mirrors the page charcoal neutrals. The switch knob is `moon.svg`; "on" lights the track white with a glow. There's no separate status line — the label text doubles as it: off reads "Dark mode is off", on picks at random from `ON_LABELS` (re-rolled on every render, so it changes when the popup is reopened too). (`--accent` is defined but currently unused.) A "Found a bug?" link at the right end of the header row opens the repo's GitHub new-issue form; `popup.js` rewrites its `href` to prefill a body with the manifest version and user agent, and the static `href` in the HTML is the fallback if that doesn't run. |
| `icons/`                                | `moon.svg` — the source of the whole icon: a moon-yellow disc (`#fce183` body, `#e8bc48` craters) with an `M` stroked in `#b6861e`. Used directly as the popup switch knob, and the PNGs are rendered from it. `icon{16,32,48,128}.png`: render `moon.svg` in headless Chrome at 128px with `--force-device-scale-factor=4 --default-background-color=00000000` (transparent corners), then downscale that master with `sips -z`. Point Chrome at a small HTML wrapper that sets the `<img>` to `128px`, not at the SVG directly — the SVG's intrinsic size is 600px, so loading it as the top-level document renders a cropped corner. **The same SVG is inlined as `MOON_SVG` in `content.js` — change both together.** |

## content.js tour

Color math & mapping

- `rgbToHsl` / `hslToRgb` — conversions.
- `remapRgb(r,g,b)` — **the heart of the theme.** Three branches (see the table
  above), memoized on the packed rgb value. Tunables: `NEUTRAL_HUE`,
  `NEUTRAL_SAT`, and the `VIVID_*` set.
- `neutralFor(l)` — the single source of truth for the neutral curve, so the
  canvas background and `remapRgb`'s neutral branch can't drift apart.
- `vividFor(h,s,l)` — accent handling: saturation to (or near) full via floor +
  gain, lightness into `[VIVID_L_MIN, VIVID_L_MAX]`, then a climb in 0.02 steps
  until `MIN_CONTRAST` is met or `VIVID_L_CEILING` stops it. Hue is untouched.
  The climb terminates because luminance rises monotonically with lightness at
  fixed hue and saturation.

  **The climb is where "blue is hard to see, green is easy" lives.** It measures
  real luminance, and the sRGB weights are wildly uneven — blue contributes
  0.0722 where green contributes 0.7152 — so at equal nominal lightness a blue
  is dim and a green already glaring. Blues therefore climb far further than
  greens with nothing hue-specific in the code: pure blue ends at `l≈0.71`,
  green stops at `l≈0.59`. Only blues and violets are affected by the value of
  `MIN_CONTRAST` at all; every other hue clears it on the first try.
- `relLuminance` / `contrastRatio` / `canvasLuminance` — WCAG 2.1 relative
  luminance. Needed because HSL lightness is **not** perceptual: yellow at
  `l=0.65` is glaring where blue at `l=0.65` is still dim, so a lightness band
  alone can't express "bright enough to read".
CSS reading & rewriting

- `parseColor(value)` — **a 1×1 canvas used as a universal color parser.** Assign
  the value to `fillStyle`, read the painted pixel, get sRGB bytes. Handles
  `oklch()`, `lab()`, `color()`, `color-mix()` and hex-with-alpha, none of which a
  regex can evaluate. Memoized — a sheet reuses the same few colors constantly.
  Validity is detected with **two sentinels**: an unparseable value leaves
  `fillStyle` at whatever preceded it, so the two reads disagree.
- `remapValue(prop, value, baseHref)` — dispatches on the property.
  `DIRECT_COLOR` longhands parse whole; `COMPOSITE_COLOR` (gradients) and
  **custom properties** go through `remapTokens`. Returns `null` for "leave as
  authored". Remapping a `--token` at its `:root` definition themes every use at
  once, which is the most redesign-proof thing the transform does.
- `remapTokens(value, baseHref)` — loose candidate regex, then `parseColor`
  validates each hit. **The regex does not need to be accurate** — a false
  positive like `repeat` is simply rejected. That inverts the usual risk: a regex
  run loose over whole stylesheet text would silently corrupt CSS; scoped to one
  value and validated, a sloppy regex costs nothing.
- `emitRule(rule, baseHref)` / `buildOverlay(rules, baseHref)` — recursive walk
  emitting only changed declarations, mirroring selector / at-rule / `@layer`
  structure. Grouping rules all expose `cssRules`, so one recursion covers
  `@media`, `@supports`, `@layer`, `@container` and future ones.
- `processLink` / `processSheetHref` / `injectOverlayFromText` — fetch,
  follow `@import`, parse, inject. `insertOverlay` advances a `cursor` so a sheet
  and its imports land in source order rather than reversed.
- `processStyleEl(styleEl)` — reads the element's **live** `sheet.cssRules`
  (same-origin, no fetch) and writes a separate overlay, so its `textContent` is
  never touched. `pollTrackedSheets` re-checks `cssRules.length` on a timer.

Apply / observe / remove

- `applyDark()` — injects the base style (canvas background + `OVERRIDES`), runs
  `scan()`, and starts a `MutationObserver` for dynamically added sheets/styles/
  inline styles. Also re-scans on `DOMContentLoaded`, `load`, and a few timers.
- `scan()` / `processLink` / `processStyleEl` / `processInlineStyles` — do the work.
- `withPaused(fn)` — runs DOM-mutating work with the observer disconnected +
  `takeRecords()` so our own writes don't feed back in.
- `removeDark()` — removes injected styles, re-enables originals, restores inline
  styles. Toggling off is fully reversible and live.

Toggle-on splash

- `playSplash()` — a spinning moon grows out of the centre of the window until it
  covers everything, then fades. 1s, Web Animations (no injected `@keyframes`, so
  no animation-name collision with the page). The moon is a circle, so the size to
  cover the viewport is its **diagonal**, not its width.
- `SPLASH_RAMP` — the growth/spin curve as sampled `[offset, scale, spin, opacity]`
  rows, walked with `linear` easing. **Every segment must be faster than the one
  before it, right through the last row**, so the moon still reads as rushing at
  the viewer when it disappears. Anything that eases out — or merely holds a
  steady rate — looks like it brakes just short of the screen. Sampling is what
  makes the rule checkable: a segment's rate is `Δvalue / Δoffset`, readable off
  the table, where a bezier can't be checked by eye and most flatten at the end.
  Scale and spin are tuned separately: scale grows by 250× across the run, spin
  only from ~610°/s to ~1375°/s (2.6 turns total). The zoom is what should feel
  like it's accelerating at you; a spin that accelerates to match reads as a
  frantic blur. `scale: 1` is exactly window-covering, so `SPLASH_COVER`'s row
  must be `1`.
  Rows past it are off-screen overshoot, seen only as crater texture streaming
  outwards. `opacity` is `null` on most rows so it interpolates between the rows
  that set it — that's how the fade gets timing independent of the growth.
- `applyAtCover()` — holds `applyDark` until `SPLASH_COVER` (72% of the run), so
  the light-to-dark swap happens hidden behind the moon, like a scene wipe.
- **Only the top frame draws the moon, but every frame must wait for cover.**
  `all_frames` gives each Garoon iframe its own copy of this script; if a subframe
  applied the theme immediately it would visibly flip dark while the moon was
  still small. So the frame role only decides `playSplash()` vs `applyAtCover()` —
  both delay by the same amount, and the whole page flips at one instant.
  `splashWanted()` is therefore deliberately frame-agnostic: visible tabs only (a
  storage change reaches every open Cybozu tab, not just the one under the popup)
  and it honours `prefers-reduced-motion`. Both read the same inside a subframe.
  When it returns false, `applyDark` runs immediately everywhere.
- `clearSplash()` — drops the pending cover timer and the node, so toggling off
  mid-animation cancels the theme apply instead of letting it land late. Needed in
  subframes too, which have a timer but no node.
- The moon SVG is inlined in `content.js` rather than read from `icons/moon.svg`:
  an extension URL would need a `web_accessible_resources` entry and can still be
  blocked by the page's CSP. Its `clipPath` id is namespaced — `url(#id)` resolves
  against the whole document, so a bare `#circle` could collide with page markup.
- Toggling **off** is instant, with no animation.

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

3a. **Never write to a page `<style>`'s `textContent`. Not even the same value.**
CSS-in-JS (styled-components, Emotion — e.g. Kintone's `sc-*`/hashed classes)
injects rules via the CSSOM (`insertRule`) and keeps `textContent` empty.
Assigning `textContent`, _even the same empty string_, makes the browser re-parse
the element and WIPE the injected rules, destroying layout. This is why
`processStyleEl` reads `styleEl.sheet.cssRules` and writes a **separate** overlay
node instead: the source element is never touched, and the library's own rule
indices stay valid. Writing to our own overlay is fine — it holds plain text.

3b. **Preserve the `<link media="...">` scope when reinjecting.** A reinjected
`<style>` defaults to `media="all"`, so a `media="print"` sheet would suddenly
apply on screen. Garoon's `print.css` has `.cloudHeader-grn{position:static
   !important}` — leaking it on screen overrode the header's runtime `position:fixed`
and broke the layout. `processLink` copies `link.media` onto the `<style>`. (Cascade
ORDER is already preserved by inserting each replacement right after its own link,
so order-dependent rules resolve the same — media was the gap.)

4. **Only ever change color _values_ — never selectors, identifiers or property
   names.** The parser enforces this structurally now, but two real bugs came from
   losing it when the transform ran over raw text: a global color replace corrupted
   id selectors that look like hex (`#abc`, `#dad`), and word-boundary keyword
   matching hit the `gray` inside `var(--component-color-border-gray)`, making the
   border invalid and reflowing Kintone's header. If you ever add matching that
   isn't scoped to one property value, you are reintroducing both.

5. **In `remapTokens`, protect `url(...)` and quoted strings.** Data-URI SVGs embed
   colors and `content`/`font-family` values may contain color words. (Shadows need
   no protection now — `box-shadow`/`text-shadow` simply aren't in
   `DIRECT_COLOR`/`COMPOSITE_COLOR`, so they're never read. They must stay that
   way: a light shadow becomes a white glow.) Protected spans are stashed behind
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
stylesheet path can't hit this — the CSSOM hands us pre-expanded longhands, see
gotcha 13.)

8. **Background _images_ with baked-in light colors are not touched** — there's no
   color token to remap. Those would need a targeted `filter` rule.

9. **`CSSLayerBlockRule` has a `.name`, just like `CSSKeyframesRule`.** Detecting
   keyframes with `typeof rule.name === "string"` therefore misidentifies
   `@layer base { … }`, emits `undefined{…}` for each child, and leaves the whole
   layer unthemed. Identify keyframes by the **children** carrying `keyText`.

10. **`replaceSync` silently drops `@import` rules** — they don't appear in
    `cssRules` at all and nothing throws. `injectOverlayFromText` extracts them
    from the text and fetches them itself; `cssomSeen` breaks import cycles.

11. **The canvas parser resolves anything unresolvable to opaque black.**
    `var(...)`, `currentColor` and the CSS-wide keywords all come back as
    `0,0,0,1`, which would invert them to near-white. They must be rejected
    *before* `parseColor` — that's what `SKIP_VALUE` is for. `initial` matters
    more than it looks: the CSSOM fills in every unset longhand of an expanded
    shorthand with it.

12. **Leave `light-dark()` alone.** `OVERRIDES` sets `color-scheme: dark`, so the
    browser already picks the site's own dark branch. Rewriting it inverts that
    branch into a *light* color — worse than doing nothing. The fixture covers it:
    `light-dark(#ffffff,#111111)` must render `rgb(17,17,17)`, not a light value.

13. **The CSSOM expands shorthands into longhands for us.** `background:#fff`
    arrives as `background-color` plus eight other longhands. Reading longhands
    only is therefore automatic here, and gotcha 7b can't happen.

14. **Emit declarations before nested children.** A style rule's own
    declarations come first in source order, then its nested rules, then any
    trailing `CSSNestedDeclarations`. Emitting in tree order preserves which one
    wins; reordering changes the result.

15. **Translucent near-white is deliberately not remapped.**
    `isProtectedTranslucent` treats it as a scrim/backdrop, so `#ffffffcc` stays
    light. That's a tuning decision, not a parse failure — if translucent white
    panels should darken, that heuristic is the knob.

## How to test (the reliable harness)

There is no automated test suite; verification is manual via headless Chrome.

Unit-test the transform in Node (it has no DOM/`chrome` deps once sliced off):

```js
// strip the runtime half, import the pure functions
let src = fs
  .readFileSync("content.js", "utf8")
  .replace(
    /\/\/ -+\n\/\/ Apply \/ remove[\s\S]*$/,
    "module.exports={remapRgb,remapValue,buildOverlay};",
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

### Synthetic fixture

A saved capture isn't needed to test the transform itself. A small fixture served
over HTTP, exercising one construct per element (native nesting, `oklch()`,
space-separated `rgb()`, 8-digit hex, `var()` tokens, `@layer`, `@keyframes`,
gradients, `light-dark()`, `media="print"`, a `<style>` populated only by
`insertRule`), plus a driver that reports `getComputedStyle` for each, gives a
a matrix of what the transform reaches.

Harness details that cost real time:

- **A driver script cannot reuse any top-level name from `content.js`.** Both are
  classic scripts sharing one global lexical scope, so re-declaring any top-level
  name (this bit on `engine`) is a `SyntaxError` that kills the *entire* driver
  file before its first line runs — with no console output and no `error` event.
  Wrap the driver in an IIFE.
- **`--dump-dom` serializes at load, ignoring `--virtual-time-budget`.** Anything
  behind a `setTimeout` or a `fetch` is missing. Either keep assertions
  synchronous, or have the driver POST results to the test server (which honours
  the virtual-time budget when paired with `--screenshot`). `--screenshot=/dev/null`
  makes the run fail — use a real path.
- **Re-enabling a disabled `<link>` is asynchronous.** After
  `link.disabled = false` the sheet is missing from `document.styleSheets` and
  computed colors read as transparent for about a tick. Nothing disables links any
  more, but this cost an hour of chasing a revert "bug" that wasn't one — assert
  teardown *after a delay*.
- **To screenshot the splash, freeze it.** One screenshot per run only catches one
  moment, and virtual time doesn't let you pick which. Instead call `playSplash`
  from the driver, then `el.getAnimations()[0].pause()` and set `currentTime` to
  the frame you want. Note the cover `setTimeout` still fires on its own clock, so
  the theme may already be applied in a frame taken "early" — a harness artifact.
- **In headless, `innerHeight` is smaller than `--window-size`'s height**, and
  `--screenshot` captures the full page. A viewport-centred fixed element is
  therefore *not* at the centre of the resulting PNG. Read
  `getBoundingClientRect()` before calling it a positioning bug.
- **`rgba(0, 0, 0, 0)` reads as "dark"** in any naive lightness check, so
  "transparent because nothing applied" and "correctly themed dark" look
  identical. Report the raw value alongside the verdict.

Testing hygiene:

- **Never `pkill` Chrome** to clean up — it kills the developer's real browser
  session. A one-off `--headless` invocation uses an ephemeral profile and exits on
  its own; just let it. (`pkill -f http.server` is fine — that's only the test server.)
- Caveat: a saved page can mislead. `file://` breaks `fetch`/cross-origin (see gotcha
  1), and a page-save tool serializes CSS-in-JS into `textContent`, hiding the live
  `insertRule` behavior (gotcha 3a). Confirm anything layout-related on the live site.

## Tuning knobs

- **Overall darkness / tint:** `NEUTRAL_HUE`, `NEUTRAL_SAT`, and the lightness curve
  `0.95 - l * 0.85` in `neutralFor`. The popup palette in `popup.css` should be kept
  in sync with the values these produce.
- **How much accents pop:** `VIVID_SAT_FLOOR` / `VIVID_SAT_GAIN` /
  `VIVID_SAT_CAP` for vividness, `VIVID_L_MIN` / `VIVID_L_MAX` for brightness,
  `MIN_CONTRAST` for the legibility floor. **Saturation is the lever for "pop";
  lightness is only for legibility.** Past l≈0.72 an HSL color mixes in white, so
  raising lightness makes greens and olives go milky rather than vivid — which is
  also why `MIN_CONTRAST` is kept at 4.0 rather than 4.5: the only colors it
  changes are blues and violets, and every step it adds makes them paler.
  `popup.css`'s `--accent` should match whatever `#0e74dd` maps to.
- **Per-element fixes:** add rules to the `OVERRIDES` template literal (doubled-class
  selectors, `!important`). This is the right place for "this specific thing is still
  light/wrong" requests. It already holds: the cloud-header bar (`HEADER_BG` constant)
  and its title text, native form controls, and scrollbars (`color-scheme` +
  `::-webkit-scrollbar`).
- **Reach more colors:** add properties to `DIRECT_COLOR` / `COMPOSITE_COLOR`.
  No keyword list is needed — the canvas parser already resolves every named CSS
  color, so `gray`, `rebeccapurple` and the rest come for free.

## Conventions

- Plain ES (no build step, no deps). Keep `content.js` self-contained.
- Match the existing comment density — explain _why_, especially around the gotchas.
- After any change, run `node --check content.js` and do an HTTP render-test before
  claiming it works.
