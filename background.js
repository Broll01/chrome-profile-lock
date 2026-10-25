importScripts("crypto.js");

/* =====================================================================
 * Constants & defaults
 * ===================================================================== */

const LOCK_URL = chrome.runtime.getURL("lock.html");
const TICK_ALARM = "profile-lock-tick";

const SLEEP_GAP_MS = 3 * 60 * 1000;       // gap between ticks that means "PC slept"
const SNAPSHOT_EVERY_MS = 5 * 60 * 1000;  // tab backup interval while unlocked
const SCHEDULE_GRACE_MS = 150 * 1000;     // how late a scheduled lock may fire
const MAX_LOG_ENTRIES = 200;

const ATTEMPTS_PER_BLOCK = 5;             // wrong tries before a temporary block
const BASE_BLOCK_MS = 30 * 1000;          // first block = 30s, doubles each round
const MAX_BLOCK_MS = 15 * 60 * 1000;

const DEFAULT_SETTINGS = {
  autoLockEnabled: true,
  autoLockMinutes: 5,
  lockOnStartup: true,
  lockOnScreenLock: true,
  lockOnSleep: true,
  scheduleEnabled: false,
  scheduleDays: [0, 1, 2, 3, 4, 5, 6],
  scheduleTimes: [],
  saveSession: true,
  theme: "dark",
  showClock: true,
  lockTitle: "",
  logo: ""
};

const REASON_LABELS = {
  manual: "Locked manually",
  shortcut: "Locked with keyboard shortcut",
  "auto-idle": "Auto-lock (inactivity)",
  "screen-locked": "Auto-lock (computer screen locked)",
  "resume-from-sleep": "Auto-lock (resumed from sleep)",
  startup: "Locked at Chrome startup",
  schedule: "Locked by schedule"
};

function defaultLockState() {
  return {
    locked: false,
    lockWindowId: null,
    windows: [],
    lastFocusedId: null,
    lockedAt: 0,
    reason: ""
  };
}

/* =====================================================================
 * Serialization
 *
 * Every task that can touch the lock state or windows runs through this
 * queue, one at a time. This is what prevents the "2-3 lock popups" bug:
 * previously several events (focus change, window created, alarm, ...)
 * ran in parallel and each one created its own lock window.
 * ===================================================================== */

let queue = Promise.resolve();

function serialize(task) {
  const result = queue.then(task);
  queue = result.catch(error => console.warn("Profile Lock task failed:", error));
  return result;
}

/* =====================================================================
 * Activity log
 * ===================================================================== */

let logChain = Promise.resolve();

function addLog(type, detail = "") {
  logChain = logChain
    .then(async () => {
      const { activityLog = [] } = await chrome.storage.local.get("activityLog");
      activityLog.push({ t: Date.now(), type, detail });
      while (activityLog.length > MAX_LOG_ENTRIES) activityLog.shift();
      await chrome.storage.local.set({ activityLog });
    })
    .catch(() => {});
  return logChain;
}

/* =====================================================================
 * Settings
 * ===================================================================== */

function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...raw };

  const minutes = Math.round(Number(s.autoLockMinutes));
  s.autoLockMinutes = Number.isFinite(minutes)
    ? Math.min(720, Math.max(1, minutes))
    : DEFAULT_SETTINGS.autoLockMinutes;

  for (const key of [
    "autoLockEnabled", "lockOnStartup", "lockOnScreenLock", "lockOnSleep",
    "scheduleEnabled", "saveSession", "showClock"
  ]) {
    s[key] = Boolean(s[key]);
  }

  const days = Array.isArray(s.scheduleDays) ? s.scheduleDays : [];
  s.scheduleDays = [...new Set(days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];

  const times = Array.isArray(s.scheduleTimes) ? s.scheduleTimes : [];
  s.scheduleTimes = [...new Set(
    times.map(String).filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))
  )].sort();

  s.theme = ["dark", "light", "auto"].includes(s.theme) ? s.theme : "dark";
  s.lockTitle = String(s.lockTitle || "").slice(0, 40);
  s.logo =
    typeof s.logo === "string" && s.logo.startsWith("data:image/") && s.logo.length < 400000
      ? s.logo
      : "";

  return s;
}

async function getSettings() {
  const data = await chrome.storage.local.get(["settings", "autoLockMinutes", "startupLock"]);
  let stored = data.settings;

  // Migrate version 1.0 settings the first time.
  if (!stored) {
    stored = {};
    if (typeof data.autoLockMinutes === "number") {
      stored.autoLockEnabled = data.autoLockMinutes > 0;
      if (data.autoLockMinutes > 0) stored.autoLockMinutes = data.autoLockMinutes;
    }
    if (typeof data.startupLock === "boolean") {
      stored.lockOnStartup = data.startupLock;
    }
  }

  return sanitizeSettings(stored);
}

async function applyIdleInterval(settings) {
  const s = settings || (await getSettings());
  chrome.idle.setDetectionInterval(Math.max(15, s.autoLockMinutes * 60));
}

async function updateSettings(patch) {
  const current = await getSettings();
  const next = sanitizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ settings: next });
  await applyIdleInterval(next);

  const changed = Object.keys(next).filter(
    key => JSON.stringify(next[key]) !== JSON.stringify(current[key])
  );
  if (changed.length) {
    addLog("settings", "Changed: " + changed.map(k => (k === "logo" ? "logo" : k)).join(", "));
  }
  return next;
}

/* =====================================================================
 * Lock state
 * ===================================================================== */

async function getLockState() {
  const { lockState } = await chrome.storage.local.get("lockState");
  return { ...defaultLockState(), ...lockState };
}

async function setLockState(state) {
  await chrome.storage.local.set({ lockState: state });
}

/* =====================================================================
 * Credentials & attempt limiter
 * ===================================================================== */

async function getCredentialMode() {
  const { cred, pinHash } = await chrome.storage.local.get(["cred", "pinHash"]);
  if (cred) return cred.mode;
  if (pinHash) return "pin";
  return null;
}

async function hasCredentials() {
  return (await getCredentialMode()) !== null;
}

async function verifySecrets(input) {
  const { cred, pinHash } = await chrome.storage.local.get(["cred", "pinHash"]);
  const pin = String(input?.pin ?? "");
  const password = String(input?.password ?? "");

  if (cred) {
    const checks = [];
    if (cred.mode !== "password") checks.push(verifySecret(pin, cred.pin));
    if (cred.mode !== "pin") checks.push(verifySecret(password, cred.password));
    const results = await Promise.all(checks);
    return results.length > 0 && results.every(Boolean);
  }

  // Version 1.0 PIN (unsalted SHA-256).
  if (pinHash) {
    return timingSafeEqual(await sha256(pin), pinHash);
  }

  return false;
}

async function getAttempts() {
  const { attempts } = await chrome.storage.local.get("attempts");
  return { streak: 0, lockedUntil: 0, ...attempts };
}

/*
 * Verifies credentials with a persistent brute-force limit.
 * The counter lives in storage, so closing/reopening the lock window
 * does not reset it (the old version kept it in page memory).
 */
async function attemptVerify(input, source) {
  const attempts = await getAttempts();
  const now = Date.now();

  if (attempts.lockedUntil > now) {
    return {
      ok: false,
      blocked: true,
      lockedUntil: attempts.lockedUntil,
      streak: attempts.streak
    };
  }

  if (await verifySecrets(input)) {
    // Upgrade a version 1.0 PIN to the stronger salted format.
    const { pinHash, cred } = await chrome.storage.local.get(["pinHash", "cred"]);
    if (pinHash && !cred) {
      await chrome.storage.local.set({
        cred: { mode: "pin", pin: await hashSecret(String(input.pin ?? "")) }
      });
      await chrome.storage.local.remove("pinHash");
    }
    await chrome.storage.local.set({ attempts: { streak: 0, lockedUntil: 0 } });
    return { ok: true, previousStreak: attempts.streak };
  }

  attempts.streak += 1;

  let blockMs = 0;
  if (attempts.streak % ATTEMPTS_PER_BLOCK === 0) {
    const round = attempts.streak / ATTEMPTS_PER_BLOCK;
    blockMs = Math.min(MAX_BLOCK_MS, BASE_BLOCK_MS * 2 ** (round - 1));
    attempts.lockedUntil = now + blockMs;
  }

  await chrome.storage.local.set({ attempts });
  addLog(
    "failed",
    `Wrong credentials (${source}) - attempt #${attempts.streak}` +
      (blockMs ? `, blocked for ${Math.round(blockMs / 1000)}s` : "")
  );

  return {
    ok: false,
    blocked: blockMs > 0,
    lockedUntil: attempts.lockedUntil,
    streak: attempts.streak,
    remaining: blockMs > 0 ? 0 : ATTEMPTS_PER_BLOCK - (attempts.streak % ATTEMPTS_PER_BLOCK)
  };
}

async function setCredentials({ current, mode, pin, password }) {
  const state = await getLockState();
  if (state.locked) return { ok: false, error: "LOCKED" };

  if (!["pin", "password", "both"].includes(mode)) {
    return { ok: false, error: "BAD_MODE" };
  }

  const needPin = mode !== "password";
  const needPassword = mode !== "pin";

  if (needPin && !/^\d{4,12}$/.test(String(pin ?? ""))) {
    return { ok: false, error: "BAD_PIN" };
  }
  if (needPassword) {
    const length = String(password ?? "").length;
    if (length < 6 || length > 128) return { ok: false, error: "BAD_PASSWORD" };
  }

  if (await hasCredentials()) {
    const result = await attemptVerify(current || {}, "settings");
    if (!result.ok) {
      return {
        ok: false,
        error: result.blocked ? "BLOCKED" : "WRONG_CURRENT",
        lockedUntil: result.lockedUntil,
        remaining: result.remaining
      };
    }
  }

  const cred = { mode, version: 2 };
  if (needPin) cred.pin = await hashSecret(String(pin));
  if (needPassword) cred.password = await hashSecret(String(password));

  await chrome.storage.local.set({ cred });
  await chrome.storage.local.remove("pinHash");
  await addLog("credentials", `Unlock method set to: ${mode}`);

  return { ok: true };
}

/* =====================================================================
 * Window helpers
 * ===================================================================== */

function isLockTab(tab) {
  return [tab.url, tab.pendingUrl].some(u => typeof u === "string" && u.startsWith(LOCK_URL));
}

// A lock window is a popup window that contains only lock.html tabs.
// (Checking the URL is what lets us find windows whose ID we have not saved yet.)
function isLockWindow(win) {
  return (
    win.type === "popup" &&
    Array.isArray(win.tabs) &&
    win.tabs.length > 0 &&
    win.tabs.every(isLockTab)
  );
}

function windowInfo(win) {
  return {
    id: win.id,
    state: win.state,
    incognito: Boolean(win.incognito),
    left: win.left,
    top: win.top,
    width: win.width,
    height: win.height
  };
}

async function minimizeWindow(win) {
  try {
    if (win.state === "fullscreen") {
      await chrome.windows.update(win.id, { state: "normal" });
    }
    await chrome.windows.update(win.id, { state: "minimized" });
  } catch (error) {
    console.warn("Could not minimize window", win.id, error);
  }
}

/*
 * Makes sure there is exactly ONE lock window.
 *  - several lock windows found -> keep one, close the extras
 *  - none found                 -> create one
 */
async function ensureLockWindow(wins, focus) {
  const lockWindows = wins.filter(isLockWindow);
  const keep = lockWindows.find(w => w.focused) || lockWindows[0];

  for (const win of lockWindows) {
    if (keep && win.id !== keep.id) {
      try { await chrome.windows.remove(win.id); } catch (_) {}
    }
  }

  if (!keep) {
    return chrome.windows.create({
      url: LOCK_URL,
      type: "popup",
      width: 460,
      height: 680,
      focused: true
    });
  }

  if (focus) {
    const info = { focused: true };
    if (keep.state === "minimized") info.state = "normal";
    try { await chrome.windows.update(keep.id, info); } catch (_) {}
  }

  return keep;
}

/*
 * Idempotent: hides every normal window and guarantees a single lock window.
 * Safe to call from any event while the profile is locked.
 */
async function enforceLocked({ focus = false } = {}) {
  const state = await getLockState();
  if (!state.locked) return;

  const wins = await chrome.windows.getAll({ populate: true });
  const known = new Set(state.windows.map(w => w.id));
  let dirty = false;

  for (const win of wins) {
    if (isLockWindow(win)) continue;

    // A window that appeared after locking: remember how it looked.
    if (!known.has(win.id)) {
      state.windows.push(windowInfo(win));
      known.add(win.id);
      dirty = true;
    }

    if (win.state !== "minimized") await minimizeWindow(win);
  }

  const lockWindow = await ensureLockWindow(wins, focus);

  if (dirty || state.lockWindowId !== lockWindow.id) {
    state.lockWindowId = lockWindow.id;
    await setLockState(state);
  }
}

/* =====================================================================
 * Session snapshots (tab backup / crash recovery)
 * ===================================================================== */

async function saveSnapshot(wins, { allowEmpty = true } = {}) {
  const windows = wins
    .filter(w => !isLockWindow(w) && !w.incognito) // never store incognito tabs
    .map(w => ({
      state: w.state,
      tabs: (w.tabs || [])
        .filter(t => /^https?:/i.test(t.url || ""))
        .map(t => ({
          url: t.url,
          title: String(t.title || "").slice(0, 120),
          pinned: Boolean(t.pinned)
        }))
    }))
    .filter(w => w.tabs.length > 0);

  if (!windows.length && !allowEmpty) return;
  await chrome.storage.local.set({ snapshot: { time: Date.now(), windows } });
}

function summarizeSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.windows)) return null;
  return {
    time: snapshot.time,
    windows: snapshot.windows.length,
    tabs: snapshot.windows.reduce((sum, w) => sum + w.tabs.length, 0)
  };
}

async function restoreSnapshot(which) {
  const state = await getLockState();
  if (state.locked) return { ok: false, error: "LOCKED" };

  const key = which === "recovery" ? "recoverySnapshot" : "snapshot";
  const snapshot = (await chrome.storage.local.get(key))[key];
  if (!snapshot || !snapshot.windows || !snapshot.windows.length) {
    return { ok: false, error: "NO_SNAPSHOT" };
  }

  // Skip tabs that are already open, so nothing is duplicated.
  const open = new Set();
  for (const win of await chrome.windows.getAll({ populate: true })) {
    for (const tab of win.tabs || []) {
      const url = tab.url || tab.pendingUrl;
      if (url) open.add(url);
    }
  }

  let opened = 0;
  for (const win of snapshot.windows) {
    const urls = win.tabs.map(t => t.url).filter(u => !open.has(u));
    if (!urls.length) continue;
    await chrome.windows.create({ url: urls, focused: false });
    urls.forEach(u => open.add(u));
    opened += urls.length;
  }

  await addLog("restore", `${opened} tab(s) restored from backup`);
  return { ok: true, opened };
}

/* =====================================================================
 * Lock / unlock
 * ===================================================================== */

async function lockInternal(reason = "manual") {
  if (!(await hasCredentials())) {
    return { ok: false, error: "NO_CREDENTIALS" };
  }

  const state = await getLockState();
  if (state.locked) {
    await enforceLocked({ focus: true });
    return { ok: true, already: true };
  }

  const settings = await getSettings();
  const wins = await chrome.windows.getAll({ populate: true });
  const others = wins.filter(w => !isLockWindow(w));

  const focusedWindow =
    others.find(w => w.focused) ||
    others.find(w => w.state !== "minimized") ||
    others[0];

  await setLockState({
    locked: true,
    lockWindowId: null,
    windows: others.map(windowInfo),
    lastFocusedId: focusedWindow ? focusedWindow.id : null,
    lockedAt: Date.now(),
    reason
  });

  if (settings.saveSession) await saveSnapshot(others);

  await addLog("lock", REASON_LABELS[reason] || reason);
  await enforceLocked({ focus: true });
  return { ok: true };
}

async function unlockInternal() {
  const state = await getLockState();
  const saved = new Map((state.windows || []).map(w => [w.id, w]));

  await setLockState(defaultLockState());

  const wins = await chrome.windows.getAll({ populate: true });

  // Close every lock window (normally just one).
  for (const win of wins) {
    if (isLockWindow(win)) {
      try { await chrome.windows.remove(win.id); } catch (_) {}
    }
  }

  const restorable = wins.filter(w => !isLockWindow(w));
  const originallyMinimized = id => saved.get(id)?.state === "minimized";

  const focusTarget =
    restorable.find(w => w.id === state.lastFocusedId && !originallyMinimized(w.id)) ||
    restorable.find(w => !originallyMinimized(w.id)) ||
    null;

  // Restore every window except the one that gets focus (it goes last).
  for (const win of restorable) {
    if (focusTarget && win.id === focusTarget.id) continue;
    const previous = saved.get(win.id);
    const target = previous ? previous.state : "normal";
    if (target === "minimized") continue; // it was minimized before locking
    try { await chrome.windows.update(win.id, { state: target }); } catch (_) {}
  }

  if (focusTarget) {
    const previous = saved.get(focusTarget.id);
    const target = previous && previous.state !== "minimized" ? previous.state : "normal";
    try {
      await chrome.windows.update(focusTarget.id, { state: target });
      await chrome.windows.update(focusTarget.id, { focused: true });
    } catch (_) {}
  }

  return { ok: true };
}

/* =====================================================================
 * Periodic tick (schedule, sleep detection, tab backup, enforcement)
 * ===================================================================== */

function ensureTickAlarm() {
  chrome.alarms.get(TICK_ALARM, alarm => {
    if (!alarm) chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  });
}

async function tickTask() {
  const now = Date.now();
  const store = await chrome.storage.local.get(["lastTick", "lastScheduleKey", "snapshot"]);
  await chrome.storage.local.set({ lastTick: now });

  const settings = await getSettings();
  const state = await getLockState();

  // Already locked: just make sure nothing is visible and there is one lock window.
  if (state.locked) {
    await enforceLocked({ focus: false });
    return;
  }

  // Best-effort "resumed from sleep" detection: ticks arrive every minute,
  // a big gap means the computer was asleep (or Chrome was frozen).
  if (store.lastTick && now - store.lastTick > SLEEP_GAP_MS && settings.lockOnSleep) {
    await lockInternal("resume-from-sleep");
    return;
  }

  // Scheduled locks.
  if (settings.scheduleEnabled && settings.scheduleTimes.length) {
    const today = new Date(now);
    if (settings.scheduleDays.includes(today.getDay())) {
      for (const time of settings.scheduleTimes) {
        const [hours, minutes] = time.split(":").map(Number);
        const target = new Date(
          today.getFullYear(), today.getMonth(), today.getDate(), hours, minutes, 0, 0
        ).getTime();
        const key = `${today.toDateString()} ${time}`;

        if (now >= target && now - target <= SCHEDULE_GRACE_MS && store.lastScheduleKey !== key) {
          await chrome.storage.local.set({ lastScheduleKey: key });
          await lockInternal("schedule");
          return;
        }
      }
    }
  }

  // Rolling tab backup for crash recovery.
  if (settings.saveSession) {
    const lastSnapshotTime = store.snapshot?.time || 0;
    if (now - lastSnapshotTime >= SNAPSHOT_EVERY_MS) {
      const wins = await chrome.windows.getAll({ populate: true });
      await saveSnapshot(wins, { allowEmpty: false });
    }
  }
}

async function startupTask() {
  await chrome.storage.local.set({ lastTick: Date.now() });

  // Keep what was open before this launch, so it can be restored after a crash.
  const { snapshot } = await chrome.storage.local.get("snapshot");
  if (snapshot) await chrome.storage.local.set({ recoverySnapshot: snapshot });

  const state = await getLockState();
  const settings = await getSettings();

  if (state.locked) {
    // Chrome was closed or crashed while locked: window IDs are stale now.
    await setLockState({ ...state, windows: [], lockWindowId: null, lastFocusedId: null });
    await addLog("lock", "Profile was locked when Chrome restarted - lock kept");
    await enforceLocked({ focus: true });
  } else if (settings.lockOnStartup) {
    await lockInternal("startup");
  }
}

/* =====================================================================
 * Message API
 * ===================================================================== */

async function handleMessage(msg) {
  switch (msg && msg.type) {
    case "GET_STATUS": {
      const [state, settings, attempts, mode] = await Promise.all([
        getLockState(), getSettings(), getAttempts(), getCredentialMode()
      ]);
      return {
        ok: true,
        locked: state.locked,
        hasCredentials: mode !== null,
        mode: mode || "pin",
        attempts: { streak: attempts.streak, lockedUntil: attempts.lockedUntil },
        settings
      };
    }

    case "LOCK_PROFILE":
      return serialize(() => lockInternal("manual"));

    case "VERIFY_UNLOCK":
      return serialize(async () => {
        const state = await getLockState();
        if (!state.locked) return { ok: true, alreadyUnlocked: true };

        const result = await attemptVerify(msg.secrets || {}, "lock screen");
        if (result.ok) {
          await unlockInternal();
          const note = result.previousStreak
            ? ` (${result.previousStreak} failed attempt(s) before)`
            : "";
          await addLog("unlock", "Unlocked successfully" + note);
        }
        return result;
      });

    case "SET_CREDENTIALS":
      return serialize(() => setCredentials(msg));

    case "UPDATE_SETTINGS":
      return serialize(async () => {
        const state = await getLockState();
        if (state.locked) return { ok: false, error: "LOCKED" };
        const settings = await updateSettings(msg.patch || {});
        return { ok: true, settings };
      });

    case "GET_SNAPSHOT_INFO": {
      const { snapshot, recoverySnapshot } = await chrome.storage.local.get([
        "snapshot", "recoverySnapshot"
      ]);
      return {
        ok: true,
        latest: summarizeSnapshot(snapshot),
        recovery: summarizeSnapshot(recoverySnapshot)
      };
    }

    case "RESTORE_SNAPSHOT":
      return serialize(() => restoreSnapshot(msg.which === "recovery" ? "recovery" : "latest"));

    case "CLEAR_LOG":
      await chrome.storage.local.set({ activityLog: [] });
      return { ok: true };

    default:
      return { ok: false, error: "UNKNOWN_MESSAGE" };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  handleMessage(msg)
    .then(sendResponse)
    .catch(error => {
      console.error("Profile Lock message error:", error);
      sendResponse({ ok: false, error: "INTERNAL" });
    });

  return true; // async response
});

/* =====================================================================
 * Event wiring (all listeners are registered synchronously)
 * ===================================================================== */

chrome.runtime.onInstalled.addListener(async details => {
  ensureTickAlarm();
  await applyIdleInterval();
  await chrome.storage.local.set({ lastTick: Date.now() });

  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureTickAlarm();
  applyIdleInterval();
  serialize(startupTask);
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === TICK_ALARM) serialize(tickTask);
});

chrome.idle.onStateChanged.addListener(newState => {
  serialize(async () => {
    const settings = await getSettings();
    if (newState === "idle" && settings.autoLockEnabled) {
      await lockInternal("auto-idle");
    } else if (newState === "locked" && settings.lockOnScreenLock) {
      await lockInternal("screen-locked");
    }
  });
});

chrome.commands.onCommand.addListener(command => {
  if (command === "lock-profile") serialize(() => lockInternal("shortcut"));
});

// While locked, anything that appears or gets focus is hidden again and the
// single lock window is brought back. enforceLocked() is idempotent, so extra
// events are harmless - they can never create a second lock window.

chrome.windows.onCreated.addListener(() => {
  serialize(() => enforceLocked({ focus: true }));
});

chrome.windows.onRemoved.addListener(() => {
  serialize(() => enforceLocked({ focus: true }));
});

chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;

  serialize(async () => {
    const state = await getLockState();
    if (!state.locked) return;
    if (windowId === state.lockWindowId) return;
    await enforceLocked({ focus: true });
  });
});

// Runs every time the service worker starts.
ensureTickAlarm();
applyIdleInterval();
