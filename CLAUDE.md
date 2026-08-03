# CLAUDE.md — Moonaroon

Context for working on this extension with Claude Code. Read this before changing
theming logic — several of the decisions here are non-obvious and load-bearing.

## What this is

**Moonaroon** is a Manifest V3 Chrome extension that applies a coherent dark mode
to **any site the user has put on a list**. The content script runs at
`document_start` in **all frames**, on every http(s) page — then gates itself on
that list. A toolbar popup holds a master on/off switch, the list editor and a
language picker. All state lives in `chrome.storage.sync`.

Two shapes of site stress very different parts of this, and both are worth
keeping in mind when changing anything:

- **Classic multi-frame apps** — many `<link>` sheets, iframes, `media="print"`,
  and elements the site already paints dark in its light theme.
- **React / styled-components apps** — CSS-in-JS injected through `insertRule`
  with no `textContent`, and custom properties named after colors.

## The core idea (and what it is NOT)

We do **not** use a blind `filter: invert()`.

Colors are remapped in HSL with **hue always preserved** — so a brand blue stays
blue, alert red stays red, and a set of category colors stays distinguishable
from one another.

The branch depends on the color **and on the role it's painted in**, which comes
from the property name via `PROP_ROLE`. The same gray needs opposite treatment as
a background and as text, and the three numbers alone cannot say which it is:

| input | `ROLE_SURFACE` (`background-color`, `background-image`) | `ROLE_INK` (`color`, `fill`, `stroke`) | `ROLE_LINE` (borders, outlines, `--tokens`) |
| --- | --- | --- | --- |
| light neutral | inverted onto charcoal | inverted onto charcoal | inverted onto charcoal |
| **dark neutral** | **`neutralSurfaceFor` — stays dark** | inverted → light | inverted → light |
| **pale (`l > 0.8`)** | dark tinted surface | **left as authored** | dark tinted surface |
| everything else | `vividFor` + `VIVID_FILL` | `vividFor` + **`VIVID_INK`** (brighter) | `vividFor` + `VIVID_FILL` |

Two of those cells are the whole point of having roles:

- **A dark neutral background stays dark.** A site that paints a header bar
  `#4b4a4a` in its *light* theme means it to be dark; inverting produces a
  glaring light slab. `neutralSurfaceFor` maps it into the same charcoal family
  as everything else instead.
- **Light ink is left alone.** Nobody writes near-white text on a light
  background — it would be invisible — so it was already sitting on something
  dark. This is the only thing that reaches text whose background is set by a
  *different rule*, or by an image no remap can read.

`ROLE_LINE` is the plain inversion, and is the default for anything unlisted. A
white border is often a spacer on a white card, so borders can't share the ink
rule without turning invisible separators into bright lines.

Accents are pushed up in saturation and lightness, then lifted further if they're
still below `MIN_CONTRAST` against the canvas — a mid-tone brand color is dull on
dark (`#0e74dd` starts at 3.8:1) and a dark one is nearly invisible (`#1c3f6e` at
1.65:1). Pale tints are deliberately *not* vivified: they're surfaces, and a
vivid surface swamps its own content.

### Background and text are decided together

A background and the text on it can't be remapped independently. Keeping a dark
bar dark while its white label inverts to near-black is *worse* than the light bar
we started with — so `changedDecls` decides both from the same declaration block:

- `needsInk` asks whether the **original** background moves somewhere its text
  can't follow. Only two cases qualify: an already-dark neutral (background stays
  dark, but the light text on it would invert), and a non-pale non-neutral
  (`vividFor` makes it far brighter than authored). A light neutral background —
  the overwhelming majority — is left alone, since it inverts to dark and its
  dark text inverts to light, which is already right.
- `inkFor` then picks whichever end of the neutral ramp reads better on the
  remapped background. Bright vivified fills get dark text; dark surfaces get
  light text.
- `inkOverride` keeps a text color the site declared if it's an *accent* that
  still clears `MIN_CONTRAST` on the new background, so colored text on a colored
  panel survives. A neutral is always replaced: it was chosen to read against the
  site's light background, and that is not what sits behind it here.

If the rule paints a qualifying background but names no text color, one is added,
because the text it inherits was picked against the light theme. That's the only
place the transform emits a declaration the site didn't have, which is why
`needsInk` is kept narrow.

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

**Never pattern-match stylesheet structure with regexes.** A regex only sees
what it was written to describe, and silently passes everything else through.
Against the test fixture it misses **native nesting** (a rule's own declarations
are skipped whenever it contains a nested block — `/\{([^{}]*)\}/g` matches only
innermost braces), **modern color syntax** (`oklch()`, `lab()`, `color()`,
space-separated `rgb()`/`hsl()`, 4- and 8-digit hex) and **CSS-in-JS** (rules
that live only in the CSSOM), and it **inverts `light-dark()` backwards**. It
also needs a pile of guards against corrupting selectors and identifiers, none of
which a parser requires. Regexes here only ever touch a single property VALUE.

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
| `manifest.json`                         | MV3 config. `all_frames: true`. `host_permissions`/`matches` are `http://*/*` + `https://*/*`, deliberately NOT `<all_urls>`: that would add `file://`, where every resource is a unique opaque origin, so the cross-origin sheet reads this whole design rests on would fail (gotcha 1). The breadth is also what lets `fetch` reach sheets on whatever CDN a page uses. Which sites are actually themed is **not** decided here — the script is injected everywhere and `hostListed()` in `content.js` gates it against the user's list. Of the three `permissions`, only `storage` is used — `scripting` and `activeTab` are unused and can be dropped. |
| `content.js`                            | All theming logic (see below).                                                                                                                                                                                                                                                   |
| `popup.html` / `popup.css` / `popup.js` | Master switch, site list, language picker. Palette mirrors the page charcoal neutrals; `--accent` is `#0e74dd` as the theme vivifies it, used for focus rings. The switch knob is `moon.svg`; "on" lights the track white with a glow. There's no separate status line — the label text doubles as it: off reads "Dark mode is off", on picks at random from the language's `on` list (re-rolled on every render, so it changes when the popup is reopened too). The header's right end stacks two asides: a language dropdown and a bug-report link (Material Symbols "bug_report", inlined with `fill: currentColor`) opening the repo's GitHub new-issue form; `popup.js` rewrites the link's `href` to prefill a body with the manifest version and user agent, and the static `href` in the HTML is the fallback if that doesn't run. Translation is attribute-driven: `data-i18n="<key>"` fills an element's text, `data-i18n-title="<key>"` sets its `title` **and** `aria-label` — the icon-only controls have no text node, so the tooltip is the only thing naming them. The language control is a native `<select>` stripped of its own chrome: its option list is drawn by the OS, so it can extend past the 300px popup edge that would clip a custom dropdown, and it gets keyboard support for free. It shows the current language's own name, so no separate icon is needed to say what it is. The caret is painted **over** the select with `pointer-events: none` — as a sibling it'd be a dead zone that looks like part of the control. Below the toggle is the **site list**: rows above a text field and an Add button, each row an entry with a cross to remove it. It's a real `<form>` so Enter submits. `normalizeHost` takes whatever is pasted — full URL, `www.`, `*.`, trailing slash, mixed case — down to one bare lowercase host; `covered()` is the same subdomain test the content script uses, so the popup and the page agree on what "already listed" means. The field is **not** prefilled from the current tab: the popup is where you edit the list, not a prompt about the page behind it. |
| `strings.js`                            | Popup UI text per language, plus `LANGS` (also the order of the dropdown, and `LANGS[0]` is the fallback) and `LANG_NAMES` (each language's name in its own script — never translated, so a reader can find their language while the UI is in another one). Adding a language = a code in `LANGS`, a name in `LANG_NAMES`, a block in `STRINGS`; the dropdown builds itself from those. Loaded as a plain classic script before `popup.js`, so these are globals — the popup paints already translated with no async step. |
| `_locales/en|ja/messages.json`          | Manifest text only: `extDescription` and `extTitle`, reached from `manifest.json` as `__MSG_extDescription__` / `__MSG_extTitle__`, with `default_locale: "en"`. Adding a UI string means editing `strings.js`; adding a manifest string means editing every locale file here. |
| `icons/`                                | `moon.svg` — the source of the whole icon: a moon-yellow disc (`#fce183` body, `#e8bc48` craters) with an `M` stroked in `#b6861e`. Used directly as the popup switch knob, and the PNGs are rendered from it. `icon{16,32,48,128}.png`: render `moon.svg` in headless Chrome at 128px with `--force-device-scale-factor=4 --default-background-color=00000000` (transparent corners), then downscale that master with `sips -z`. Point Chrome at a small HTML wrapper that sets the `<img>` to `128px`, not at the SVG directly — the SVG's intrinsic size is 600px, so loading it as the top-level document renders a cropped corner. **The same SVG is inlined as `MOON_SVG` in `content.js` — change both together.** |

## content.js tour

Color math & mapping

- `rgbToHsl` / `hslToRgb` — conversions.
- `remapRgb(r,g,b,role)` — **the heart of the theme.** Branches on the color and
  the role (see the table above), memoized on the packed rgb **plus the role** —
  the same rgb has different answers in different roles, so the role must be in
  the cache key. Returns `null` for "leave the authored value", which is how
  light ink survives. Tunables: `NEUTRAL_HUE`, `NEUTRAL_SAT`, `SURFACE_PEAK`, and
  the two `VIVID_*` tuning objects.
- `neutralFor(l)` — the single source of truth for the neutral curve, so the
  canvas background and `remapRgb`'s neutral branch can't drift apart.
- `neutralSurfaceFor(l)` — the same curve for neutral *backgrounds*, which must
  always come out dark. Above `SURFACE_PEAK` (0.75) it *is* `neutralFor`:
  light-theme surfaces cluster in the top fifth of the range (`#fff`, `#f7f7f7`,
  `#eee` sit within 0.07 of each other) and inverting expands that into a usable
  spread. Below the peak it rises from the canvas floor instead, so darker input
  stays darker. **The two meet exactly at the peak** — derived from
  `NEUTRAL_L_BASE`/`NEUTRAL_L_SPAN` rather than written as a literal, so there's
  no step in the middle of the range if the curve is ever retuned.
- `inkFor(bg)` / `needsInk(r,g,b,a)` / `inkForBlock(style)` / `inkOverride(...)` —
  pairing a background with its text (see the section above). `INK_LIGHT` and
  `INK_DARK` are the two ends of the neutral ramp rather than literal white and
  black, so forced text stays in the theme's charcoal family.
- `vividFor(h,s,l,t)` — accent handling, against a tuning `t`: saturation to (or
  near) full via `satFloor` + `satGain`, lightness into `[lMin, lMax]`, then a
  climb in 0.02 steps until `minContrast` is met or `lCeiling` stops it. Hue is
  untouched. The climb terminates because luminance rises monotonically with
  lightness at fixed hue and saturation.

  **The climb is where "blue is hard to see, green is easy" lives.** It measures
  real luminance, and the sRGB weights are wildly uneven — blue contributes
  0.0722 where green contributes 0.7152 — so at equal nominal lightness a blue
  is dim and a green already glaring. Blues therefore climb far further than
  greens with nothing hue-specific in the code. Only blues and violets are
  affected by the value of `minContrast` at all; every other hue clears it on the
  first try.
- `VIVID_FILL` / `VIVID_INK` — the two tunings. Text is thin strokes and has to
  carry on color alone, where a fill carries on area, so ink gets a higher band
  (`0.60–0.74` against `0.54–0.68`) and a higher floor (`INK_MIN_CONTRAST` 5.5
  against `MIN_CONTRAST` 4.0). Measured, that's brand blue 6.0:1 → 7.0:1 and
  purple 4.0:1 → 5.7:1, with fills untouched.

  **The saturation curve is identical in both, on purpose.** Raising it for ink
  is the obvious alternative and it does not work: `satFloor * satGain` already
  lands every accent at ~0.945 of a possible 1.0, so there is nothing to gain —
  and in sRGB the only way to add chroma above `l=0.5` is to *remove* lightness.
  Measured, a more saturated ink tuning lowers contrast (brand blue 6.0:1 → 5.2:1,
  orange 9.9 → 9.3) for a difference too small to see. Saturation is not the lever
  here; lightness is. The cost of using
  it is real but acceptable: raising the band drops chroma 14–20%, which is why
  `lMax` stops at 0.74 — past `l≈0.72` an HSL color is mixing in white, and
  greens and olives start reading milky rather than brighter.
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
- `remapValue(prop, value, baseHref)` — dispatches on the property, twice over.
  It picks the **role** from `PROP_ROLE` (defaulting to `ROLE_LINE`) and passes it
  down; and it picks the shape — `DIRECT_COLOR` longhands parse whole, while
  `COMPOSITE_COLOR` (gradients) and **custom properties** go through
  `remapTokens`. Returns `null` for "leave as authored". Remapping a `--token` at
  its `:root` definition themes every use at once, which is the most
  redesign-proof thing the transform does — but it's also why tokens can't have a
  role, since a token has none until something uses it.
- `remapTokens(value, baseHref, role)` — loose candidate regex, then `parseColor`
  validates each hit. **The regex does not need to be accurate** — a false
  positive like `repeat` is simply rejected. That inverts the usual risk: a regex
  run loose over whole stylesheet text would silently corrupt CSS; scoped to one
  value and validated, a sloppy regex costs nothing.

  `MAYBE_COLOR` guards the three regex passes below it. Every color notation
  contains a `#`, a `(`, or a run of three letters — hex, a function, or a named
  color — so a value with none of them cannot hold one. That is what keeps the
  numeric half of a design system (`--space-4: 16px`, `--z-10: 100`) out of the
  expensive path.

- `changedDecls(style, baseHref)` / `isColorProp(prop)` — serialize the changed
  declarations of one block. **Test the property name first; read the CSSOM
  last.** See gotcha 19 — this ordering is worth ~40% of the whole sheet walk and
  reads like a stylistic choice, so it is easy to undo by accident.
- `emitRule(rule, baseHref)` / `buildOverlay(rules, baseHref)` — recursive walk
  emitting only changed declarations, mirroring selector / at-rule / `@layer`
  structure. Grouping rules all expose `cssRules`, so one recursion covers
  `@media`, `@supports`, `@layer`, `@container` and future ones.
- `processLink` / `processSheetHref` / `injectOverlayFromText` — fetch,
  follow `@import`, parse, inject. `insertOverlay` advances a `cursor` so a sheet
  and its imports land in source order rather than reversed.
- `processStyleEl(styleEl)` — reads the element's **live** `sheet.cssRules`
  (same-origin, no fetch) and writes a separate overlay, so its `textContent` is
  never touched. Records `css`, `count` and `tail` on the tracked entry for the
  poller.
- `pollTrackedSheets()` — a timer, because `insertRule` fires no DOM mutation for
  the observer to see. It **extends** each overlay rather than rebuilding it: a
  library that adds one rule per render would otherwise walk every rule it has
  ever added, on every tick, for as long as the page is open. Only rules past
  `count` are emitted and appended to the accumulated `css`.

  `insertRule` can splice into the middle as well as append, so an index alone
  proves nothing. `tail` holds the previous pass's last rule text, and the
  append-only path is taken **only** when the rule now sitting at that index
  still matches it. Everything else — a mid-list insert, a `deleteRule`, a reset
  — falls back to a full `buildOverlay`. Both paths must produce identical CSS;
  the poll fixture asserts exactly that.

Apply / observe / remove

- `applyDark()` — injects the base style (canvas background + `OVERRIDES`), runs
  `scan()`, and starts a `MutationObserver` for dynamically added sheets/styles/
  inline styles. Also re-scans on `DOMContentLoaded`, `load`, and a few timers.
- `remapInlineStyle(el)` — rewrites one element's inline style in place, since
  nothing outranks a `style` attribute short of `!important`. Idempotent by
  design; see gotchas 7c and 7d, which are the whole reason it looks the way it
  does. `readInlineRecords`/`writeInlineRecords` keep the per-property
  `original`/`written` pairs in a data attribute rather than a `WeakMap`, so
  `removeDark` can find every touched element with one `querySelectorAll` and
  nothing is retained when an element is dropped from the page.
- `scan()` / `processLink` / `processStyleEl` / `processInlineStyles` — do the
  work. `scan()` runs six times per apply (immediately, on `DOMContentLoaded`, on
  `load`, and on three timers), so each of these has to be near-free once there
  is nothing left to do. `processInlineStyles` gets that from its selector —
  `[style]:not([data-moonaroon]):not([data-moonaroon-gen])` — which lets the
  selector engine reject handled elements instead of two `getAttribute` calls per
  element in JS.
- `withPaused(fn)` — runs DOM-mutating work with the observer disconnected +
  `takeRecords()` so our own writes don't feed back in.
- `removeDark()` — removes injected styles, re-enables originals, restores inline
  styles. Toggling off is fully reversible and live.

Which sites are themed

- `hostListed()` — is this host on the user's list (`SITES_KEY` in
  `chrome.storage.sync`)? An entry covers the bare host **and every subdomain**,
  the same reach a `*.example.com` manifest pattern has, so a list entry means
  what people expect it to. `popup.js` normalizes to a bare host on the way in,
  so the matcher never has to deal with a scheme, a path or a `www.`.
- `refresh(animate)` — the theme applies where the master switch is on AND the
  host is listed. **It compares against `applied` and returns early if nothing
  changed.** A `storage.sync` write reaches every open tab, so editing the list
  for *some other* site fires this listener here too — without the guard, every
  unrelated edit would replay the splash and re-apply an already-applied theme.
- The gate lives here rather than in dynamically registered content scripts.
  Injecting everywhere and deciding in one function keeps the whole rule
  readable, and costs nothing on an unlisted host: nothing in this file runs
  until `sync()` is called with true.

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
  `all_frames` gives each iframe its own copy of this script; if a subframe
  applied the theme immediately it would visibly flip dark while the moon was
  still small. So the frame role only decides `playSplash()` vs `applyAtCover()` —
  both delay by the same amount, and the whole page flips at one instant.
  `splashWanted()` is therefore deliberately frame-agnostic: visible tabs only (a
  storage change reaches every open tab, not just the one under the popup)
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

## Gotchas (each one is load-bearing)

1. **Test over HTTP, never `file://`.** Chrome treats every `file://` resource as a
   unique opaque origin, so cross-file CSS reads throw `SecurityError` and `fetch`
   behaves differently. A `file://` render will look "mostly themed" via the base
   background alone and **lie to you**. Use a local HTTP server (below).

2. **Anything we inject must be marked `GEN` (`data-moonaroon-gen`)** so the remapper
   never re-processes it. Without the mark, the base style is a stylesheet like
   any other: its own `#191919` canvas inverts to a light `#dddddd`, washing the
   whole page out.

3. **Never double-transform a sheet.** The remap is not idempotent (`#fff` → dark →
   light). Each `<link>`/`<style>` is guarded with `PROCESSED` and transformed once.

3a. **Never write to a page `<style>`'s `textContent`. Not even the same value.**
CSS-in-JS (styled-components, Emotion, and the `sc-*`/hashed-class libraries)
injects rules via the CSSOM (`insertRule`) and keeps `textContent` empty.
Assigning `textContent`, _even the same empty string_, makes the browser re-parse
the element and WIPE the injected rules, destroying layout. This is why
`processStyleEl` reads `styleEl.sheet.cssRules` and writes a **separate** overlay
node instead: the source element is never touched, and the library's own rule
indices stay valid. Writing to our own overlay is fine — it holds plain text.

3b. **Preserve the `<link media="...">` scope when reinjecting.** A reinjected
`<style>` defaults to `media="all"`, so a `media="print"` sheet would suddenly
apply on screen. A print sheet holding something like
`.header{position:static !important}` then overrides the header's runtime
`position:fixed` and breaks the layout. `processLink` copies `link.media` onto the
`<style>`. Cascade ORDER needs no such care — each replacement is inserted
directly after its own link, so order-dependent rules resolve identically.

4. **Only ever change color _values_ — never selectors, identifiers or property
   names.** The parser enforces this structurally: it hands over one declaration
   value at a time, and nothing else is reachable. Matching over raw text is not
   safe, because CSS reuses color syntax elsewhere — a global color replace
   corrupts id selectors that look like hex (`#abc`, `#dad`), and word-boundary
   keyword matching hits the `gray` inside `var(--component-color-border-gray)`,
   which invalidates the declaration and reflows the page. Any matching that isn't
   scoped to a single property value reopens both.

5. **In `remapTokens`, protect `url(...)` and quoted strings.** Data-URI SVGs embed
   colors and `content`/`font-family` values may contain color words. (Shadows
   need no protection: `box-shadow`/`text-shadow` are absent from
   `DIRECT_COLOR`/`COMPOSITE_COLOR`, so they're never read. They must stay absent
   — a light shadow becomes a white glow.) Protected spans are stashed behind
   placeholders delimited by Private-Use Unicode chars (`U+E000` / `U+E001`,
   written as `\uE000`/`\uE001` escapes in the source) — chosen because they
   can't occur in CSS. Keep delimiters out of the normal text range so they never
   collide with stylesheet content; do NOT use NUL bytes (they make the file read
   as binary to `git`/`grep`).

6. **A color alone cannot be remapped correctly — the role is half the input.**
   Sites style some elements dark in their _light_ theme (a header bar at
   `#4b4a4a` with light text on it). Inverting that turns it _light_, which is
   wrong; but inverting dark _text_ to light is right, and the two are the same
   three numbers. `PROP_ROLE` is what separates them: a `remapRgb` that takes only
   a color cannot be correct for both. Its corollary is gotcha 6b — a background
   and its text must be decided **together**.

6b. **Never change a background's treatment without checking its text.** Keeping
a dark bar dark while its white label still inverts to near-black is worse than
the light bar it replaced — the fixture measured 1.04:1. `changedDecls` therefore
runs `inkForBlock` over the whole declaration block before emitting anything.
This is also the only place the transform **adds** a declaration the site didn't
write, so `needsInk` stays narrow: it fires only where the inherited text would
otherwise be unreadable, never on the ordinary light-neutral background that
already works.

6c. **Text whose background lives in another rule is only reachable by the
"light ink stays light" rule.** `.bar{background:#333}` with
`.bar .title{color:#fff}` gives `changedDecls` no way to pair them — different
blocks, possibly different sheets, processed in fetch order. Nothing static can
pair those. What saves it is that near-white text is *already* correct on dark,
so `ROLE_INK` leaves it alone. Same for text over a background **image**, which
has no color token to read at all. If that rule is ever weakened, both cases go
back to black-on-black.

7. **Native form controls & scrollbars have no CSS color** — the browser draws them
   from UA defaults the remapper never sees. `OVERRIDES` forces inputs/textarea/select
   to a dark field with light text, sets `color-scheme: dark` + `scrollbar-color`, and
   adds `::-webkit-scrollbar` rules so native scrollbars are charcoal.

7b. **Inline-style remapping uses longhands only.** `remapInlineStyle` must not
read both a shorthand and its longhand (`background` + `background-color`,
`border-color` + `border-*-color`): remapping the shorthand sets the longhand, then
reading the longhand and remapping again double-inverts it (`#fff` → dark → light).
It reads only longhands, which already reflect whatever a shorthand set. (The
stylesheet path can't hit this — the CSSOM hands us pre-expanded longhands, see
gotcha 13.)

7c. **`querySelectorAll` never returns the element it is called on.** So
`processInlineStyles` examines its root separately from searching it. This is not
a detail: the observer hands over *the element whose `style` attribute changed*,
and every element added after the last `scan()` timer arrives the same way. Search
only the descendants and the entire dynamic half of inline theming silently does
nothing, while a static page still looks perfect — `scan()` passes `document`,
which has no style attribute of its own to miss.

7d. **An inline style can be remapped more than once, so it must be idempotent.**
A page that sets one unrelated property (`el.style.left = "10px"`) leaves our
colors sitting in the attribute beside it and fires an attribute mutation. Reading
those back as if the page had written them re-inverts them. `remapInlineStyle`
therefore records `prop::original::written` and skips any property whose current
value still equals `written`.

**Record what the CSSOM reports, not what was passed to `setProperty`.** It
normalizes `#171a1c` to `rgb(23, 26, 28)`, so a `written` taken from our own hex
never matches a later read, every pass treats our output as fresh input, and the
saved `original` decays into our own dark value — which surfaces as `removeDark`
restoring the page to the theme rather than to the site.

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

16. **The popup can't use `chrome.i18n.getMessage()`.** That API resolves to the
    browser UI language and has no runtime override, so the popup's language
    button could never beat it. Popup text therefore comes from `STRINGS` in
    `strings.js`; `_locales/` holds the manifest strings only. The manifest ones
    genuinely cannot be overridden — Chrome resolves them before any extension
    code runs — so the extension description and toolbar tooltip always follow
    the browser, even when the popup is showing the other language. That's
    accepted, not a bug to chase.

17. **Anything read back from `chrome.storage.sync` must be validated.** It syncs
    across profiles, so it can hand back a value written by a different build.
    `render()` indexes `STRINGS[lang]` directly, so an unknown language code would
    throw and leave the popup blank — the load path checks `STRINGS[stored]`
    exists and falls back to the browser language. The site list gets the same
    treatment (`Array.isArray`, then `.sort()`, since the returned order isn't
    necessarily the order it was written in).

18. **A `storage.sync` write reaches every open tab, not just the one under the
    popup.** So `content.js` cannot act on the change event directly: adding an
    entry for site A fires the listener in every tab of site B as well, and
    re-running `sync()` there would replay the splash and re-apply an
    already-applied theme. `refresh()` compares the newly computed state against
    `applied` and returns early when nothing changed. The same fact is why
    `splashWanted()` checks `document.visibilityState`.

19. **In the per-declaration path, order the tests by what they cost:
    property name, then value text, then the CSSOM.** A rule's declarations are
    mostly longhands the CSSOM invented while expanding a shorthand —
    `background:#fff` arrives as nine, eight of them filler — so the great
    majority of what this loop sees can never hold a color. `isColorProp` is a
    Set lookup; `SKIP_VALUE` is a regex over text; `getPropertyValue` and
    `getPropertyPriority` are crossings into the CSSOM and cost the most by far.
    `changedDecls` therefore checks the name before reading anything, and reads
    the priority only once a declaration is definitely being emitted.

    Measured on a 2400-rule sheet: 204,321 CSSOM property reads against 35,823,
    and 31.3ms against 18.2ms. **Reading the value up front is the natural way to
    write this loop and looks tidier**, which is exactly why it needs saying —
    the cost is invisible at the call site.

## How to test (the reliable harness)

There is no automated test suite; verification is manual via headless Chrome.

### Color math in Node

The **color math only** runs headless — slice the file at the `Reading
stylesheets` banner. Everything past it needs a DOM (`parseColor` paints into a
`<canvas>`), so `remapValue` and `buildOverlay` can NOT be unit-tested this way;
they belong in the browser fixture below.

```js
const src = fs
  .readFileSync("content.js", "utf8")
  .split("// " + "-".repeat(75) + "\n// Reading stylesheets")[0];
// A Function wrapper, not eval: both this file and the slice declare top-level
// names like rgbToHsl, and re-declaring one is a SyntaxError that kills the
// whole script.
const M = new Function(src + "\nreturn {rgbToHsl,vividFor,remapRgb,VIVID_INK};")();
```

Good for sweeping a table of hues through `vividFor` and printing chroma and
contrast per tuning — which is how the `VIVID_INK` numbers were settled, and the
only way to see that a change helps one hue and hurts another.

### Render-test over HTTP

Never `file://` (gotcha 1). Serve a directory and point headless Chrome at it:

```
python3 -m http.server 8731
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
  --disable-gpu --window-size=1440,2200 --virtual-time-budget=9000 \
  --screenshot=out.png "http://localhost:8731/test.html"
```

The page under test loads a copy of `content.js` with the `chrome.storage` wiring
stripped (`src.split("// Initial state")[0]`) and `applyDark()` appended, since
there's no extension runtime to supply the state.

Against a **real saved page** ("Save Page As → Web Page, Complete"): **copy the
capture to a throwaway dir and test there — never generate test files inside the
original capture folder.** A cleanup glob in that folder deletes the capture
itself, and `rm` does not go to Trash. Captures are the developer's own and are
**not** committed. Strip the page's own `<script>`s, which hang headless, and
inject the script into the iframe sub-pages too to simulate `all_frames`.

### Synthetic fixture

A saved capture isn't needed to test the transform itself. A small fixture served
over HTTP, exercising one construct per element (native nesting, `oklch()`,
space-separated `rgb()`, 8-digit hex, `var()` tokens, `@layer`, `@keyframes`,
gradients, `light-dark()`, `media="print"`, a `<style>` populated only by
`insertRule`), plus a driver that reports `getComputedStyle` for each, gives a
a matrix of what the transform reaches.

**For anything touching roles or the ink pairing, measure contrast, don't look at
a screenshot.** A second fixture covers one background/text arrangement per row —
dark bg with same-rule text, dark bg with the text on a *descendant* rule, dark bg
with inherited text only, bright brand bg with a white label, the same with a
black label, a colored panel with accent text, a plain light card, and three light
grays that must stay distinguishable from each other. The driver walks up to the
first opaque background, computes the WCAG ratio against the element's own text,
and prints `bg / text / ratio` per row with a `FAIL` marker under 3:1. That's what
caught the descendant-rule case at 1.04:1, which reads as an ordinary dark bar in
a screenshot. Run the same snapshot again after `removeDark()` to confirm every
value returns to the light-theme original.

### Overlay equivalence

`pollTrackedSheets` has two paths to the same CSS, so the fixture asserts they
agree: drive a `<style>` through `insertRule`/`deleteRule`, call the poller, and
compare the accumulated `tracked.css` against a fresh `buildOverlay` of the same
rules. Cover append-only over several ticks, a mid-list insert, a `deleteRule`,
an append after a delete, and an appended `@media` block — the last three are the
fallback path, and the mid-list insert is the one that silently emits the wrong
rules if the `tail` check is ever dropped. Assert `overlay.textContent` matches
the accumulated string too, or the two can drift without any visible symptom.

### Dynamic inline styles

The static fixtures cannot see gotchas 7c and 7d, because everything they contain
is present before the first `scan()`. Cover the dynamic half separately: after the
last retry timer (2500ms) has passed, add an element with an inline style and no
styled descendants, add one that *has* a styled descendant, set a `style`
attribute on an element that had none, touch a single unrelated property on an
element already themed, and rewrite a whole `style` attribute. Then call
`removeDark()` and assert every element is back to its authored value — that last
step is what catches a `written` record that never matches, since the theme still
looks right until teardown.

Include a dark inline box (`background:#4b4a4a;color:#fff`) and check the label
stays light. And note that a forced light label is `INK_LIGHT`, not `#ffffff` —
asserting pure white there fails against correct output.

### Testing the popup

`popup.html` renders outside the extension if a stub is injected **before**
`strings.js`, since the only APIs it needs are `chrome.storage.sync`,
`chrome.i18n.getUILanguage` and `chrome.runtime.getManifest`. Back the storage
stub with a plain object and the popup is fully interactive.

Drive it from a second script that dispatches `submit` on the form and clicks the
remove buttons, then writes the resulting host list into a `<pre>` and screenshot
that — the same trick the theme fixture uses, and it works because everything
here is synchronous. Worth covering: a pasted full URL, `www.`, `*.`, a trailing
dot, a duplicate, a subdomain of an existing entry, and a non-host. Render the
empty list and the Japanese strings too — Japanese is the wider script, and it's
what clipped the input placeholder at 300px.

Harness details worth knowing before they cost an afternoon:

- **A driver script cannot reuse any top-level name from `content.js`.** Both are
  classic scripts sharing one global lexical scope, so re-declaring any top-level
  name is a `SyntaxError` that kills the *entire* driver file before its first
  line runs — with no console output and no `error` event. Wrap the driver in an
  IIFE.
- **`--dump-dom` serializes at load, ignoring `--virtual-time-budget`.** Anything
  behind a `setTimeout` or a `fetch` is missing. Either keep assertions
  synchronous, or have the driver POST results to the test server (which honours
  the virtual-time budget when paired with `--screenshot`). `--screenshot=/dev/null`
  makes the run fail — use a real path.
- **Assert teardown after a delay, not synchronously.** Some style changes settle
  a tick late — re-enabling a disabled `<link>`, for one: right after
  `link.disabled = false` the sheet is absent from `document.styleSheets` and
  computed colors read as transparent. Reading immediately after `removeDark()`
  reports a revert failure that isn't one.
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
  `NEUTRAL_L_BASE - l * NEUTRAL_L_SPAN` in `neutralFor`. The popup palette in
  `popup.css` should be kept in sync with the values these produce.
- **How dark backgrounds land:** `SURFACE_PEAK` in `neutralSurfaceFor`. Raising it
  gives already-dark surfaces more room to separate from each other but squeezes
  the light-neutral surfaces that make up most of a page; lowering it does the
  reverse. Both halves of the curve are derived from the `NEUTRAL_L_*` constants,
  so they stay joined wherever the peak sits.
- **How much accents pop:** the `VIVID_FILL` and `VIVID_INK` objects — `lMin` /
  `lMax` for brightness, `minContrast` for the legibility floor, `satFloor` /
  `satGain` / `satCap` for saturation. Tune the two independently; that's the
  point of their being separate.

  **Lightness is the lever; saturation is already spent.** `satFloor * satGain`
  puts every accent at ~0.945 of a possible 1.0, so raising it buys ~5% of chroma
  and *costs* contrast, because above `l=0.5` in sRGB chroma can only be bought
  with lightness. Going the other way is what works, at a measured 14–20% of
  chroma per band raise — so past `l≈0.72` greens and olives read milky rather
  than brighter, which is what `lMax` is guarding.

  `MIN_CONTRAST` stays at 4.0 for fills; only blues and violets are affected by
  it at all, and every step it adds makes them paler. `INK_MIN_CONTRAST` is 5.5
  and does double duty — it's also the bar `inkOverride` uses to decide whether an
  accent text color still reads on its new background. `popup.css`'s `--accent`
  should match whatever `#0e74dd` maps to.
- **Which text gets forced:** `needsInk`'s two thresholds — neutral `l < 0.5` and
  non-neutral `l <= 0.8`. Widening either makes the transform restate `color` on
  more rules, which overrides more inherited text; that's the cost to weigh.
- **Per-element fixes:** add rules to the `OVERRIDES` template literal (doubled-class
  selectors, `!important`). It currently holds only native form controls and
  scrollbars (`color-scheme` + `::-webkit-scrollbar`) — things no stylesheet
  declares. A rule naming one site's markup does not belong there while the
  extension runs on every host; that needs a per-site overrides store.
- **Reach more colors:** add properties to `DIRECT_COLOR` / `COMPOSITE_COLOR`, and
  give them a role in `PROP_ROLE` if they aren't a plain line. No keyword list is
  needed — the canvas parser already resolves every named CSS color, so `gray`,
  `rebeccapurple` and the rest come for free.

## Conventions

- Plain ES (no build step, no deps). Keep `content.js` self-contained.
- Match the existing comment density — explain _why_, especially around the gotchas.
- After any change, run `node --check content.js` and do an HTTP render-test before
  claiming it works.
