const statusBox = $("status");
const subtitle = $("subtitle");
const lockBtn = $("lockBtn");
const autoToggle = $("autoToggle");

async function refresh() {
  const info = await send({ type: "GET_STATUS" });

  if (!info.ok) {
    statusBox.textContent = "Extension is not responding.";
    subtitle.textContent = "";
    lockBtn.disabled = true;
    return;
  }

  applyTheme(info.settings.theme);
  const settings = info.settings;

  autoToggle.checked = settings.autoLockEnabled;
  $("autoLabel").textContent = settings.autoLockEnabled
    ? `Auto-lock after ${settings.autoLockMinutes} min of inactivity`
    : "Auto-lock is off";

  if (!info.hasCredentials) {
    subtitle.textContent = "Not set up";
    statusBox.textContent = "No PIN or password yet. Create one to start using the lock.";
    lockBtn.textContent = "Set Up Lock";
    lockBtn.onclick = () => {
      chrome.runtime.openOptionsPage();
      window.close();
    };
    autoToggle.disabled = true;
  } else if (info.locked) {
    subtitle.textContent = "Locked";
    statusBox.textContent = "🔒 Profile is locked.";
    lockBtn.textContent = "Show Lock Screen";
    lockBtn.onclick = async () => {
      await send({ type: "LOCK_PROFILE" });
      window.close();
    };
    autoToggle.disabled = true;
  } else {
    subtitle.textContent = "Unlocked";
    statusBox.textContent = "🔓 Profile is unlocked.";
    lockBtn.textContent = "Lock Profile";
    lockBtn.onclick = async () => {
      await send({ type: "LOCK_PROFILE" });
      window.close();
    };
    autoToggle.disabled = false;
  }
}

autoToggle.addEventListener("change", async () => {
  const result = await send({
    type: "UPDATE_SETTINGS",
    patch: { autoLockEnabled: autoToggle.checked }
  });
  if (!result.ok) autoToggle.checked = !autoToggle.checked;
  refresh();
});

$("settingsBtn").onclick = () => {
  chrome.runtime.openOptionsPage();
  window.close();
};

async function showShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const lock = commands.find(c => c.name === "lock-profile");
    $("shortcutHint").textContent = lock && lock.shortcut
      ? `Shortcut: ${lock.shortcut}`
      : "No keyboard shortcut set (chrome://extensions/shortcuts)";
  } catch (_) {}
}

refresh();
showShortcut();
