function setStatus(message, type = "") {
  const statusEl = document.getElementById("status");
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function renderPreview(data) {
  const titleEl = document.getElementById("preview-title");
  const textEl = document.getElementById("preview-text");
  const metaEl = document.getElementById("preview-meta");

  if (!data) {
    titleEl.textContent = "";
    textEl.textContent = "";
    metaEl.textContent = "No preview available.";
    return;
  }

  const previewText = (data.cleanedText || "").trim();
  const urlText = data.url ? ` | ${data.url}` : "";
  const confidenceText = typeof data.confidence === "number" ? ` | confidence ${(data.confidence * 100).toFixed(0)}%` : "";

  titleEl.textContent = data.title || "Untitled Page";
  textEl.textContent = previewText || "(No text extracted from this page yet.)";
  metaEl.textContent = `${previewText.length} chars${confidenceText}${urlText}`;
  textEl.scrollTop = 0;
}

function guessCompanyFromTitle(title) {
  const source = title || "";
  const parts = source
    .split(/\s+[\-\|@:]\s+|\s+-\s+|\s+\|\s+|\s+at\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    return source.trim() || "Unknown Company";
  }

  const likelyCompany = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  return likelyCompany.slice(0, 120);
}

function guessPositionFromTitle(title) {
  const source = (title || "").trim();
  if (!source) {
    return "General Role";
  }

  const separators = [" | ", " - ", " @ ", " at ", ":"];
  let best = source;

  separators.forEach((sep) => {
    if (source.includes(sep)) {
      const first = source.split(sep)[0].trim();
      if (first && first.length >= 3) {
        best = first;
      }
    }
  });

  return best.slice(0, 140);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function getCaptureFromBackground(reason = "popup") {
  const response = await chrome.runtime.sendMessage({ type: "CAPTURE_ACTIVE_TAB", reason });
  if (!response?.ok) {
    throw new Error(response?.message || "Could not capture this tab.");
  }
  return response.data;
}

async function refreshLastStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_LAST_CAPTURE_STATUS" });
    if (!response?.ok) {
      return;
    }

    if (response.draft?.company) {
      document.getElementById("company").value = response.draft.company;
      if (!document.getElementById("position").value.trim()) {
        document.getElementById("position").value = response.draft.position || "";
      }
      renderPreview(response.draft);
      setStatus("Low-confidence shortcut capture loaded for review.", "error");
      await chrome.runtime.sendMessage({ type: "CLEAR_LAST_AUTO_CAPTURE_DRAFT" });
      return;
    }

    if (!response.status) {
      return;
    }

    const status = response.status;
    const ts = status.at ? new Date(status.at).toLocaleTimeString() : "";
    const suffix = ts ? ` (${ts})` : "";

    if (status.ok) {
      setStatus(`Last capture: ${status.message}${suffix}`, "success");
    } else {
      setStatus(`Last capture failed: ${status.message}${suffix}`, "error");
    }
  } catch (_error) {
    // Silent on status refresh failures.
  }
}

async function autofillCompany() {
  const companyInput = document.getElementById("company");
  const positionInput = document.getElementById("position");

  try {
    const data = await getCaptureFromBackground("popup_autofill");
    companyInput.value = guessCompanyFromTitle(data.title);
    if (!positionInput.value.trim()) {
      positionInput.value = guessPositionFromTitle(data.title);
    }
    renderPreview(data);
  } catch (_error) {
    const fallbackTab = await getActiveTab();
    companyInput.value = guessCompanyFromTitle(fallbackTab?.title || "");
    if (!positionInput.value.trim()) {
      positionInput.value = guessPositionFromTitle(fallbackTab?.title || "");
    }
    renderPreview({
      title: fallbackTab?.title || "Untitled Page",
      cleanedText: "",
      confidence: 0,
      url: fallbackTab?.url || ""
    });
  }
}

async function handleCapture(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const captureButton = document.getElementById("capture-button");
  const company = form.company.value.trim();
  const position = form.position.value.trim();
  const note = form.note.value.trim();

  if (!company || !position) {
    setStatus("Company and Position are required.", "error");
    return;
  }

  captureButton.disabled = true;
  setStatus("Capturing current page...");

  try {
    const scraped = await getCaptureFromBackground("popup_capture");
    renderPreview(scraped);

    const saveResult = await window.BreadcrumbStorage.saveScrapWithPolicy(company, position, {
      rawText: scraped.cleanedText,
      url: scraped.url || window.location.href,
      note: note || undefined,
      confidence: scraped.confidence,
      captureSource: "popup_manual"
    }, { dedup: true });

    chrome.runtime.sendMessage({ type: "VAULT_DATA_CHANGED", reason: "save_scrap" }).catch(() => {});

    const confidenceText = typeof scraped.confidence === "number" ? ` (${(scraped.confidence * 100).toFixed(0)}% confidence)` : "";
    setStatus(`Captured and ${saveResult.outcome === "merged" ? "merged" : "saved"} to vault${confidenceText}.`, "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Capture failed.", "error");
  } finally {
    captureButton.disabled = false;
  }
}

async function openVaultSidePanel() {
  try {
    const tab = await getActiveTab();
    if (!tab || typeof tab.id !== "number") {
      throw new Error("No active tab to attach side panel.");
    }

    await chrome.sidePanel.setOptions({ tabId: tab.id, path: "options.html", enabled: true });
    await chrome.sidePanel.open({ tabId: tab.id });
    setStatus("Vault opened in side panel.", "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to open side panel.", "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("capture-form");
  const openSidePanelButton = document.getElementById("open-side-panel");
  form.addEventListener("submit", handleCapture);
  openSidePanelButton.addEventListener("click", openVaultSidePanel);
  autofillCompany();
  refreshLastStatus();
});
