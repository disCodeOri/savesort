const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { openPath } = window.__TAURI__.opener;

// The server URL lives in Rust (see resolved_base_url) so SAVESORT_BASE_URL
// governs every network path, including sign-in.
const REFRESH_INTERVAL_MS = 3_000;

const element = (id) => document.getElementById(id);

function showError(message) {
  const box = element("error");
  if (!message) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.hidden = false;
  box.textContent = message;
}

function withBusy(button, label, action) {
  return async () => {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    showError(null);
    try {
      await action();
      await refresh();
    } catch (error) {
      showError(typeof error === "string" ? error : String(error));
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  };
}

const PHASE_LABELS = {
  not_signed_in: "Sign in required",
  no_vault: "Choose a vault",
  initial_sync: "Initial sync…",
  syncing: "Syncing…",
  synced: "Synced",
  offline: "Offline",
  paused: "Paused",
  attention_required: "Attention required",
};

async function refresh() {
  const [status, signedIn] = await Promise.all([
    invoke("get_status"),
    invoke("is_signed_in"),
  ]);

  element("status-line").textContent = PHASE_LABELS[status.phase] ?? status.phase;
  element("signed-out").hidden = signedIn;
  element("signed-in").hidden = !signedIn;

  element("vault-path").textContent = status.vaultPath ?? "Not selected";
  element("synced-count").textContent = status.syncedNotes;
  element("pending-count").textContent = status.pendingOperations;
  element("attention-count").textContent = status.conflicts + status.errors;

  const toggle = element("toggle-pause");
  toggle.textContent = status.paused ? "Resume" : "Pause";
  toggle.dataset.paused = String(status.paused);
}

element("sign-in").onclick = withBusy(
  element("sign-in"),
  "Waiting for browser…",
  () => invoke("sign_in"),
);

element("sign-out").onclick = withBusy(element("sign-out"), "Signing out…", () =>
  invoke("sign_out"),
);

element("choose-vault").onclick = withBusy(
  element("choose-vault"),
  "Choosing…",
  async () => {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    await invoke("select_vault", { path: selected });
  },
);

element("sync-now").onclick = withBusy(element("sync-now"), "Syncing…", () =>
  invoke("sync_now"),
);

element("toggle-pause").onclick = withBusy(
  element("toggle-pause"),
  "Working…",
  () => {
    const paused = element("toggle-pause").dataset.paused === "true";
    return invoke("set_paused", { paused: !paused });
  },
);

element("open-logs").onclick = withBusy(element("open-logs"), "Opening…", async () => {
  const directory = await invoke("get_log_directory");
  if (directory) await openPath(directory);
});

refresh().catch((error) => showError(String(error)));
setInterval(() => {
  refresh().catch(() => {
    // A transient read failure should not spam the error box; the next
    // tick will correct the display.
  });
}, REFRESH_INTERVAL_MS);
