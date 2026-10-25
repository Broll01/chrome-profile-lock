let status = null;
let pendingLogo; // undefined = unchanged, "" = remove, string = new data URL

/* ---------- Credentials ---------- */

function updateCredentialFields() {
  const mode = $("newMode").value;
  $("newPinFields").hidden = mode === "password";
  $("newPasswordFields").hidden = mode === "pin";
}

function renderCredentials() {
  const has = status.hasCredentials;

  $("credTitle").textContent = has ? "Change PIN / Password" : "Create PIN / Password";
  $("currentBox").hidden = !has;
  $("curPinField").hidden = status.mode === "password";
  $("curPasswordField").hidden = status.mode === "pin";
  $("newMode").value = status.mode || "pin";
  updateCredentialFields();
}

function credentialError(result) {
  switch (result.error) {
    case "BAD_PIN":
      return "The PIN must be 4–12 digits.";
    case "BAD_PASSWORD":
      return "The password must be at least 6 characters.";
    case "WRONG_CURRENT": {
      const left = result.remaining;
      return `Current ${credentialNoun(status.mode)} is incorrect.` +
        (left ? ` ${left} ${left === 1 ? "attempt" : "attempts"} left before a temporary lock.` : "");
    }
    case "BLOCKED":
      return `Too many wrong attempts. Try again in ${formatDuration(result.lockedUntil - Date.now())}.`;
    case "LOCKED":
      return "Unlock the profile first.";
    default:
      return "Could not save. Please try again.";
  }
}

function setMessage(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle("is-error", isError);
}

$("newMode").addEventListener("change", updateCredentialFields);

$("saveCred").addEventListener("click", async () => {
  const message = $("credMessage");
  const mode = $("newMode").value;
  const pin = $("newPin").value;
  const password = $("newPassword").value;

  if (mode !== "password") {
    if (!/^\d{4,12}$/.test(pin)) return setMessage(message, "The PIN must be 4–12 digits.", true);
    if (pin !== $("confirmPin").value) return setMessage(message, "The PINs do not match.", true);
  }

  if (mode !== "pin") {
    if (password.length < 6) return setMessage(message, "The password must be at least 6 characters.", true);
    if (password !== $("confirmPassword").value) return setMessage(message, "The passwords do not match.", true);
  }

  const result = await send({
    type: "SET_CREDENTIALS",
    current: { pin: $("curPin").value, password: $("curPassword").value },
    mode,
    pin,
    password
  });

  if (!result.ok) return setMessage(message, credentialError(result), true);

  for (const id of ["curPin", "curPassword", "newPin", "confirmPin", "newPassword", "confirmPassword"]) {
    $(id).value = "";
  }

  setMessage(message, "Saved successfully.");
  await refresh();
});

/* ---------- Settings ---------- */

function renderSettings(settings) {
  $("autoLockEnabled").checked = settings.autoLockEnabled;
  $("autoMinutes").value = String(settings.autoLockMinutes);
  $("lockOnStartup").checked = settings.lockOnStartup;
  $("lockOnScreenLock").checked = settings.lockOnScreenLock;
  $("lockOnSleep").checked = settings.lockOnSleep;

  $("scheduleEnabled").checked = settings.scheduleEnabled;
  document.querySelectorAll("[data-day]").forEach(box => {
    box.checked = settings.scheduleDays.includes(Number(box.dataset.day));
  });
  $("scheduleTimes").value = settings.scheduleTimes.join(", ");

  $("theme").value = settings.theme;
  $("showClock").checked = settings.showClock;
  $("lockTitle").value = settings.lockTitle;
  $("saveSession").checked = settings.saveSession;

  renderLogoPreview(settings.logo);
}

function renderLogoPreview(logo) {
  $("logoPreview").hidden = !logo;
  $("removeLogo").hidden = !logo;
  if (logo) $("logoPreview").src = logo;
}

function parseTimes(text) {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  const times = [];

  for (const part of parts) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(part);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
    times.push(`${match[1].padStart(2, "0")}:${match[2]}`);
  }

  return times;
}

$("saveSettings").addEventListener("click", async () => {
  const message = $("settingsMessage");
  const times = parseTimes($("scheduleTimes").value);

  if (times === null) {
    return setMessage(message, "Use times like 09:00, 13:30, 22:00 (24-hour format).", true);
  }

  const patch = {
    autoLockEnabled: $("autoLockEnabled").checked,
    autoLockMinutes: Number($("autoMinutes").value),
    lockOnStartup: $("lockOnStartup").checked,
    lockOnScreenLock: $("lockOnScreenLock").checked,
    lockOnSleep: $("lockOnSleep").checked,
    scheduleEnabled: $("scheduleEnabled").checked,
    scheduleDays: [...document.querySelectorAll("[data-day]")]
      .filter(box => box.checked)
      .map(box => Number(box.dataset.day)),
    scheduleTimes: times,
    theme: $("theme").value,
    showClock: $("showClock").checked,
    lockTitle: $("lockTitle").value.trim(),
    saveSession: $("saveSession").checked
  };

  if (pendingLogo !== undefined) patch.logo = pendingLogo;

  const result = await send({ type: "UPDATE_SETTINGS", patch });

  if (!result.ok) {
    return setMessage(message, result.error === "LOCKED" ? "Unlock the profile first." : "Could not save settings.", true);
  }

  pendingLogo = undefined;
  applyTheme(result.settings.theme);
  renderSettings(result.settings);
  setMessage(message, "Settings saved.");
  await renderLog();
});

/* ---------- Logo ---------- */

$("logoFile").addEventListener("change", () => {
  const file = $("logoFile").files[0];
  if (!file) return;

  if (file.size > 5 * 1024 * 1024) {
    return setMessage($("settingsMessage"), "Please choose an image smaller than 5 MB.", true);
  }

  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      // Shrink to at most 160x160 so it stays small in storage.
      const scale = Math.min(1, 160 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);

      pendingLogo = canvas.toDataURL("image/png");
      renderLogoPreview(pendingLogo);
      setMessage($("settingsMessage"), "Logo ready. Click “Save settings” to apply it.");
    };
    image.onerror = () => setMessage($("settingsMessage"), "That image could not be read.", true);
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
});

$("removeLogo").addEventListener("click", () => {
  pendingLogo = "";
  $("logoFile").value = "";
  renderLogoPreview("");
  setMessage($("settingsMessage"), "Logo removed. Click “Save settings” to apply it.");
});

/* ---------- Session recovery ---------- */

function describeSnapshot(info) {
  return info
    ? `${info.tabs} tab(s) in ${info.windows} window(s), saved ${formatDateTime(info.time)}`
    : "none";
}

async function renderSnapshots() {
  const info = await send({ type: "GET_SNAPSHOT_INFO" });
  if (!info.ok) return;

  $("snapshotInfo").textContent =
    `Before last Chrome start: ${describeSnapshot(info.recovery)}. ` +
    `Latest backup: ${describeSnapshot(info.latest)}.`;

  $("restoreRecovery").disabled = !info.recovery;
  $("restoreLatest").disabled = !info.latest;
}

async function restore(which) {
  const message = $("restoreMessage");
  const result = await send({ type: "RESTORE_SNAPSHOT", which });

  if (result.ok) {
    setMessage(message, result.opened ? `Opened ${result.opened} tab(s).` : "Everything is already open.");
  } else {
    setMessage(message, result.error === "LOCKED" ? "Unlock the profile first." : "No backup available.", true);
  }
}

$("restoreRecovery").addEventListener("click", () => restore("recovery"));
$("restoreLatest").addEventListener("click", () => restore("latest"));

/* ---------- Activity log ---------- */

async function renderLog() {
  const { activityLog = [] } = await chrome.storage.local.get("activityLog");
  const list = $("log");
  list.textContent = "";

  if (!activityLog.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "No activity yet.";
    list.append(empty);
    return;
  }

  for (const entry of activityLog.slice(-100).reverse()) {
    const item = document.createElement("li");

    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = formatDateTime(entry.t);

    const tag = document.createElement("span");
    tag.className = `tag tag-${entry.type}`;
    tag.textContent = entry.type;

    const detail = document.createElement("span");
    detail.textContent = entry.detail;

    item.append(time, tag, detail);
    list.append(item);
  }
}

$("clearLog").addEventListener("click", async () => {
  await send({ type: "CLEAR_LOG" });
  renderLog();
});

$("shortcutBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

/* ---------- Init ---------- */

async function refresh() {
  status = await send({ type: "GET_STATUS" });
  if (!status.ok) return;

  applyTheme(status.settings.theme);
  renderCredentials();
  renderSettings(status.settings);
  await renderSnapshots();
  await renderLog();
}

bindReveal();
refresh();
