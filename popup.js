const STORAGE_KEY = "moonaroonEnabled";

const toggle = document.getElementById("toggle");
const label = document.getElementById("label");

function render(enabled) {
  toggle.checked = enabled;
  label.textContent = enabled ? "Dark mode is on" : "Dark mode is off";
}

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
