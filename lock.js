let status = null;
let busy = false;
let countdown = null;

const form = $("unlockForm");
const errorBox = $("error");

function setBusy(value) {
  busy = value;
  $("pin").disabled = value;
  $("password").disabled = value;
  $("submit").disabled = value;
}

function setupFields(mode) {
  $("pinField").hidden = mode === "password";
  $("passwordField").hidden = mode === "pin";

  $("prompt").textContent = {
    pin: "Enter your PIN to continue.",
    password: "Enter your password to continue.",
    both: "Enter your PIN and password to continue."
  }[mode] || "Enter your PIN to continue.";

  focusFirstField();
}

function focusFirstField() {
  const field = status && status.mode === "password" ? $("password") : $("pin");
  field.focus();
}

function applyBranding(settings) {
  applyTheme(settings.theme);

  const title = settings.lockTitle || "Profile Locked";
  $("title").textContent = title;
  document.title = title;

  if (settings.logo) {
    $("logo").src = settings.logo;
    $("logo").hidden = false;
    $("defaultIcon").hidden = true;
  }

  $("clockBox").hidden = !settings.showClock;
}

function startClock() {
  const update = () => {
    const now = new Date();
    $("clock").textContent = now.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
    $("date").textContent = now.toLocaleDateString([], {
      weekday: "long",
      day: "numeric",
      month: "long"
    });
  };

  update();
  setInterval(update, 1000);
}

function shake() {
  const card = $("card");
  card.classList.remove("shake");
  void card.offsetWidth; // restart the animation
  card.classList.add("shake");
}

function showError(text, kind = "error") {
  errorBox.textContent = text;
  errorBox.dataset.kind = kind;
}

function renderAttempts(attempts) {
  clearInterval(countdown);
  countdown = null;

  $("attempts").textContent = attempts.streak
    ? `Failed attempts: ${attempts.streak}`
    : "";

  const update = () => {
    const left = attempts.lockedUntil - Date.now();

    if (left > 0) {
      setBusy(true);
      showError(`Too many wrong attempts. Try again in ${formatDuration(left)}.`, "blocked");
      return;
    }

    clearInterval(countdown);
    countdown = null;
    setBusy(false);

    if (errorBox.dataset.kind === "blocked") showError("");
    focusFirstField();
  };

  if (attempts.lockedUntil > Date.now()) {
    update();
    countdown = setInterval(update, 500);
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;

  const pin = $("pin").value;
  const password = $("password").value;

  if (
    (status.mode !== "password" && !pin) ||
    (status.mode !== "pin" && !password)
  ) {
    showError(`Please enter your ${credentialNoun(status.mode)}.`);
    shake();
    return;
  }

  setBusy(true);
  showError("");

  const result = await send({
    type: "VERIFY_UNLOCK",
    secrets: { pin, password }
  });

  if (result.ok) {
    // The background script closes this window. Fallback in case it does not.
    window.close();
    return;
  }

  $("pin").value = "";
  $("password").value = "";
  shake();

  if (result.error) {
    setBusy(false);
    showError("Something went wrong. Please try again.");
    return;
  }

  renderAttempts({
    streak: result.streak || 0,
    lockedUntil: result.lockedUntil || 0
  });

  if (!result.blocked) {
    setBusy(false);
    const noun = credentialNoun(status.mode);
    const left = result.remaining;
    showError(
      `Incorrect ${noun}. ${left} ${left === 1 ? "attempt" : "attempts"} left before a temporary lock.`
    );
    focusFirstField();
  }
});

async function init() {
  bindReveal();
  status = await send({ type: "GET_STATUS" });

  if (!status.ok) {
    showError("Could not reach the extension. Please reopen Chrome.");
    return;
  }

  applyBranding(status.settings);

  if (!status.locked) {
    $("prompt").textContent = "The profile is not locked.";
    form.hidden = true;
    window.close();
    return;
  }

  setupFields(status.mode);
  if (status.settings.showClock) startClock();
  renderAttempts(status.attempts);
}

init();
