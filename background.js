const DB_NAME = "BreadcrumbDB";
const DB_VERSION = 1;
const STORE_NAME = "companies";
const SCHEMA_VERSION = 2;
const CONFIDENCE_THRESHOLD = 0.55;

let dbPromise = null;

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }
  return [...new Set(tags.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))];
}

function normalizeUrlForDedup(url) {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return String(url).trim().toLowerCase();
  }
}

function toLocalDayKey(dateInput) {
  const date = new Date(dateInput);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return `${safe.getFullYear()}-${String(safe.getMonth() + 1).padStart(2, "0")}-${String(safe.getDate()).padStart(2, "0")}`;
}

function dedupKey({ url, timestamp, position }) {
  return `${normalizeUrlForDedup(url)}|${toLocalDayKey(timestamp)}|${String(position || "").trim().toLowerCase()}`;
}

function guessCompanyFromTitle(title) {
  const source = String(title || "").trim();
  const parts = source
    .split(/\s+[\-\|@:]\s+|\s+-\s+|\s+\|\s+|\s+at\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    return source || "Unknown Company";
  }

  return (parts.length > 1 ? parts[parts.length - 1] : parts[0]).slice(0, 120) || "Unknown Company";
}

function guessPositionFromTitle(title) {
  const source = String(title || "").trim();
  if (!source) {
    return "General Role";
  }

  const separators = [" | ", " - ", " @ ", " at ", ":"];
  let best = source;
  separators.forEach((sep) => {
    if (source.includes(sep)) {
      const first = source.split(sep)[0].trim();
      if (first.length >= 3) {
        best = first;
      }
    }
  });
  return best.slice(0, 140) || "General Role";
}

function openDb() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "name" });
        store.createIndex("name", "name", { unique: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`Failed to open IndexedDB: ${request.error?.message || "Unknown error"}`));
    request.onblocked = () => reject(new Error("IndexedDB open request blocked."));
  });

  return dbPromise;
}

function normalizeScrap(scrap) {
  return {
    timestamp: scrap.timestamp || new Date().toISOString(),
    url: String(scrap.url || ""),
    rawText: String(scrap.rawText || ""),
    note: scrap.note ? String(scrap.note) : undefined,
    status: scrap.status || "saved",
    tags: normalizeTags(scrap.tags || []),
    favorite: Boolean(scrap.favorite),
    confidence: typeof scrap.confidence === "number" ? scrap.confidence : undefined,
    captureSource: scrap.captureSource || "shortcut_auto",
    schemaVersion: SCHEMA_VERSION,
    captureCount: Number.isInteger(scrap.captureCount) && scrap.captureCount > 0 ? scrap.captureCount : 1
  };
}

async function saveScrapWithPolicyInBackground(companyName, positionName, scrapInput) {
  const db = await openDb();
  const scrap = normalizeScrap(scrapInput);
  let outcome = "created";

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(companyName);

    request.onsuccess = () => {
      const company = request.result || { name: companyName, positions: [] };
      if (!Array.isArray(company.positions)) {
        company.positions = [];
      }

      let position = company.positions.find((item) => item.name === positionName);
      if (!position) {
        position = { name: positionName, scraps: [] };
        company.positions.push(position);
      }

      if (!Array.isArray(position.scraps)) {
        position.scraps = [];
      }

      const targetKey = dedupKey({ url: scrap.url, timestamp: scrap.timestamp, position: positionName });
      const existing = position.scraps.find((item) => {
        const key = dedupKey({ url: item.url, timestamp: item.timestamp, position: positionName });
        return key === targetKey;
      });

      if (existing) {
        existing.rawText = scrap.rawText;
        existing.url = scrap.url;
        existing.note = scrap.note || existing.note;
        existing.confidence = scrap.confidence;
        existing.captureSource = scrap.captureSource;
        existing.tags = normalizeTags([...(existing.tags || []), ...(scrap.tags || [])]);
        existing.captureCount = (existing.captureCount || 1) + 1;
        existing.lastEditedAt = new Date().toISOString();
        existing.schemaVersion = SCHEMA_VERSION;
        outcome = "merged";
      } else {
        position.scraps.push(scrap);
      }

      store.put(company);
    };

    request.onerror = () => reject(new Error(`Failed to load company for auto-save: ${request.error?.message || "Unknown error"}`));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error(`Auto-save transaction failed: ${tx.error?.message || "Unknown error"}`));
    tx.onabort = () => reject(new Error(`Auto-save transaction aborted: ${tx.error?.message || "Unknown error"}`));
  });

  return { outcome, scrap };
}

async function setLastCaptureStatus(status) {
  await chrome.storage.local.set({ lastCaptureStatus: { ...status, at: new Date().toISOString() } });
}

async function setLastAutoCaptureDraft(draft) {
  await chrome.storage.local.set({ lastAutoCaptureDraft: { ...draft, at: new Date().toISOString() } });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "SCRAPE_JOB_DETAILS" });
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  }
}

async function scrapeTab(tabId) {
  await ensureContentScript(tabId);
  const response = await chrome.tabs.sendMessage(tabId, { type: "SCRAPE_JOB_DETAILS" });

  if (!response?.ok || !response?.data) {
    throw new Error(response?.error || "Unable to scrape this page.");
  }

  return response.data;
}

async function notifyVaultChanged(reason) {
  try {
    await chrome.runtime.sendMessage({ type: "VAULT_DATA_CHANGED", reason });
  } catch (_error) {
    // Ignore when no listeners are active.
  }
}

async function captureFromTab(tab, reason = "manual") {
  if (!tab || typeof tab.id !== "number") {
    const error = { ok: false, code: "NO_ACTIVE_TAB", message: "No active tab found.", confidence: 0 };
    await setLastCaptureStatus({ ...error, reason });
    return error;
  }

  try {
    const data = await scrapeTab(tab.id);
    const confidence = typeof data.confidence === "number" ? data.confidence : 0;

    const result = {
      ok: true,
      code: "CAPTURED",
      message: "Capture ready.",
      reason,
      confidence,
      data: {
        title: data.title || tab.title || "Untitled Page",
        cleanedText: data.cleanedText || "",
        url: data.url || tab.url || "",
        confidence,
        sectionHints: data.sectionHints || []
      }
    };

    await setLastCaptureStatus(result);
    return result;
  } catch (error) {
    const failure = {
      ok: false,
      code: "SCRAPE_FAILED",
      message: error instanceof Error ? error.message : "Capture failed.",
      reason,
      confidence: 0
    };
    await setLastCaptureStatus(failure);
    return failure;
  }
}

async function runShortcutAutoCapture() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const capture = await captureFromTab(tab, "shortcut");

  if (!capture.ok) {
    return capture;
  }

  const company = guessCompanyFromTitle(capture.data.title);
  const position = guessPositionFromTitle(capture.data.title);
  const confidence = capture.confidence || 0;

  if (confidence < CONFIDENCE_THRESHOLD || !capture.data.cleanedText || capture.data.cleanedText.length < 300) {
    const draft = {
      company,
      position,
      title: capture.data.title,
      url: capture.data.url,
      cleanedText: capture.data.cleanedText,
      confidence,
      reason: "low_confidence"
    };

    await setLastAutoCaptureDraft(draft);

    try {
      await chrome.action.openPopup();
    } catch (_error) {
      // Popup may be blocked by platform/version; status still guides user.
    }

    const needsReview = {
      ok: true,
      code: "NEEDS_REVIEW",
      message: "Capture needs review in popup before saving.",
      confidence,
      data: draft
    };

    await setLastCaptureStatus(needsReview);
    return needsReview;
  }

  const saveResult = await saveScrapWithPolicyInBackground(company, position, {
    timestamp: new Date().toISOString(),
    url: capture.data.url,
    rawText: capture.data.cleanedText,
    note: undefined,
    status: "saved",
    tags: [],
    favorite: false,
    confidence,
    captureSource: "shortcut_auto",
    captureCount: 1
  });

  const saved = {
    ok: true,
    code: "AUTO_SAVED",
    message: `Auto-saved (${saveResult.outcome}) to ${company} / ${position}.`,
    confidence,
    data: {
      company,
      position,
      url: capture.data.url,
      outcome: saveResult.outcome,
      dedupKey: dedupKey({ url: capture.data.url, timestamp: new Date().toISOString(), position })
    }
  };

  await setLastCaptureStatus(saved);
  await notifyVaultChanged("shortcut_auto_save");
  return saved;
}

chrome.action.onClicked.addListener(async (tab) => {
  await captureFromTab(tab, "action_click");
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "trigger-action") {
    return;
  }
  await runShortcutAutoCapture();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CAPTURE_ACTIVE_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const result = await captureFromTab(tabs[0], message.reason || "popup");
      sendResponse(result);
    });
    return true;
  }

  if (message?.type === "GET_LAST_CAPTURE_STATUS") {
    chrome.storage.local.get(["lastCaptureStatus", "lastAutoCaptureDraft"], (data) => {
      sendResponse({ ok: true, status: data.lastCaptureStatus || null, draft: data.lastAutoCaptureDraft || null });
    });
    return true;
  }

  if (message?.type === "CLEAR_LAST_AUTO_CAPTURE_DRAFT") {
    chrome.storage.local.remove("lastAutoCaptureDraft", () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "OPEN_VAULT_SIDE_PANEL") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];

      if (!tab) {
        sendResponse({ ok: false, message: "No active tab to attach side panel." });
        return;
      }

      try {
        await chrome.sidePanel.setOptions({ tabId: tab.id, path: "options.html", enabled: true });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, message: error instanceof Error ? error.message : "Unable to configure side panel." });
      }
    });
    return true;
  }
});
