const STORAGE_KEY = "moonaroonEnabled";

const toggle = document.getElementById("toggle");
const label = document.getElementById("label");

// The "on" label is picked at random each time it's rendered — so it changes both
// when the switch is flipped and when the popup is reopened. The switch itself is
// what actually reports state; these just have to read as celebratory.
const ON_LABELS = [
  "Darkness restored!",
  "Squint no more!",
  "Lights out!",
  "Eye burn averted!",
  "Release the moon!",
];
const OFF_LABEL = "Dark mode is off";

function render(enabled) {
  toggle.checked = enabled;
  label.textContent = enabled
    ? ON_LABELS[Math.floor(Math.random() * ON_LABELS.length)]
    : OFF_LABEL;
}

// Prefill the issue with the version and browser, so a report says which build it
// came from. The anchor's plain href already works on its own if this doesn't run.
const report = document.getElementById("report");
const body = [
  "**What happened?**",
  "",
  "",
  "**Where?** (Garoon / Kintone, and which screen)",
  "",
  "",
  `Moonaroon ${chrome.runtime.getManifest().version}`,
  navigator.userAgent,
].join("\n");
report.href =
  "https://github.com/jmadelaine/moonaroon/issues/new" +
  `?labels=bug&body=${encodeURIComponent(body)}`;

// Load current state
chrome.storage.sync.get({ [STORAGE_KEY]: false }, (res) => {
  render(res[STORAGE_KEY]);
});

// Persist on change (content script reacts via storage.onChanged)
toggle.addEventListener("change", () => {
  const enabled = toggle.checked;
  chrome.storage.sync.set({ [STORAGE_KEY]: enabled }, () => {
    render(enabled);
  });
});
