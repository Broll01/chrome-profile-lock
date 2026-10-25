/* Small helpers shared by lock.js, popup.js and options.js */

function $(id) {
  return document.getElementById(id);
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch(() => ({
    ok: false,
    error: "NO_RESPONSE"
  }));
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme || "dark";
}

// Show/Hide buttons: <button class="reveal" data-target="inputId">
function bindReveal() {
  document.querySelectorAll(".reveal").forEach(button => {
    button.addEventListener("click", () => {
      const input = $(button.dataset.target);
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.textContent = show ? "🙈" : "👁";
      button.setAttribute("aria-pressed", String(show));
      button.setAttribute("aria-label", show ? "Hide" : "Show");
      input.focus();
    });
  });
}

function formatDateTime(timestamp) {
  return new Date(timestamp).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function credentialNoun(mode) {
  return { pin: "PIN", password: "password", both: "PIN or password" }[mode] || "PIN";
}
