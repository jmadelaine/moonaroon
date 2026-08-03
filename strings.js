// Popup UI strings, keyed by language code.
//
// These deliberately do NOT go through chrome.i18n.getMessage(). That API always
// resolves to the browser UI language and offers no runtime override, so the
// language picker in the popup cannot win against it. A plain table read
// synchronously also means the popup paints already translated — a fetch would
// show English for a frame first.
//
// _locales/ carries the two manifest strings only (extension description and
// toolbar tooltip). Chrome resolves those itself before any extension code runs
// and nothing can override them, so they belong there and nowhere else. Adding a
// UI string means adding it here; adding a manifest string means adding it to
// every _locales/<lang>/messages.json.

// Order matters: it's the order of the language dropdown. LANGS[0] is also the
// fallback when the browser language isn't one we have.
const LANGS = ["en", "ja"];

// Each language's name in its own script, NOT translated per UI language. Someone
// who only reads Japanese has to be able to find 日本語 in the list while the popup
// is still in English — that only works if the entry never changes.
//
// Adding a language means: a code in LANGS, its name here, and a block in STRINGS.
// The dropdown builds itself from these, so there's nothing else to update.
const LANG_NAMES = {
  en: "English",
  ja: "日本語",
};

const STRINGS = {
  en: {
    tagline: "Dark mode for any site",
    // Tooltip and accessible name for the icon-only bug link — it has no visible
    // text, so this is the only thing naming it.
    reportBug: "Report a bug",
    // Accessible name for the dropdown. The options themselves come from
    // LANG_NAMES and stay in their own script.
    langLabel: "Language",
    off: "Dark mode is off",
    on: [
      "Darkness restored!",
      "Squint no more!",
      "Lights out!",
      "Eye burn averted!",
      "Release the moon!",
    ],
    issueWhat: "**What happened?**",
    issueWhere: "**Where?** (the page URL, and which screen)",
    sitesLabel: "Sites",
    sitesEmpty: "No sites yet. Add one below.",
    sitePlaceholder: "Add a site for dark mode",
    addSite: "Add",
    removeSite: "Remove",
  },
  ja: {
    tagline: "どんなサイトもダークモードに",
    reportBug: "不具合を報告",
    langLabel: "言語",
    off: "ダークモードはオフ",
    on: [
      "闇が戻った！",
      "もう目を細めなくていい！",
      "消灯！",
      "眼球、無事。",
      "月よ、いでよ！",
    ],
    issueWhat: "**何が起きましたか？**",
    issueWhere: "**どこで？**（ページの URL と、画面名）",
    sitesLabel: "対象サイト",
    sitesEmpty: "まだありません。下から追加してください。",
    // Fits the field at 300px. "…を追加" as well would clip — the Add button
    // beside it already says that.
    sitePlaceholder: "ダークモードにするサイト",
    addSite: "追加",
    removeSite: "削除",
  },
};
