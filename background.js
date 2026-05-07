const DB_NAME = "BreadcrumbDB";
const DB_VERSION = 1;
const STORE_NAME = "companies";
const SCHEMA_VERSION = 2;
const CONFIDENCE_THRESHOLD = 0.55;

let dbPromise = null;
const githubOAuthFlows = new Map();
const GITHUB_OAUTH_FLOW_KEY = "githubOAuthDeviceFlow";
const GITHUB_OAUTH_TOKEN_KEY = "githubOAuthToken";

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

function hashString(input) {
  const source = String(input || "");
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function ensureBackupId(companyName, positionName, scrap) {
  if (scrap.backupId && String(scrap.backupId).trim()) {
    return String(scrap.backupId).trim();
  }
  const timestamp = String(scrap.timestamp || new Date().toISOString());
  const normalizedUrl = normalizeUrlForDedup(scrap.url || "");
  const seed = `${timestamp}|${normalizedUrl}|${String(companyName || "").trim().toLowerCase()}|${String(positionName || "").trim().toLowerCase()}`;
  scrap.backupId = `bkp_${hashString(seed)}`;
  return scrap.backupId;
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
    captureCount: Number.isInteger(scrap.captureCount) && scrap.captureCount > 0 ? scrap.captureCount : 1,
    backupId: typeof scrap.backupId === "string" && scrap.backupId.trim() ? scrap.backupId.trim() : undefined
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
        existing.backupId = ensureBackupId(companyName, positionName, existing);
        outcome = "merged";
      } else {
        scrap.backupId = ensureBackupId(companyName, positionName, scrap);
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

function utf8ToBase64(input) {
  return btoa(unescape(encodeURIComponent(String(input || ""))));
}

function base64ToUtf8(input) {
  return decodeURIComponent(escape(atob(String(input || ""))));
}

async function githubRequest({ method = "GET", endpoint, token, body }) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    if (response.status === 404) {
      return { ok: false, status: 404, data: null };
    }
    const text = await response.text();
    throw new Error(`GitHub API error (${response.status}): ${text.slice(0, 240)}`);
  }

  return { ok: true, status: response.status, data: await response.json() };
}

async function getGithubFile(config, filePath) {
  const endpoint = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${filePath}?ref=${encodeURIComponent(config.branch || "main")}`;
  const response = await githubRequest({ endpoint, token: config.token });
  if (!response.ok && response.status === 404) {
    return null;
  }
  const file = response.data;
  return {
    sha: file.sha,
    content: file.content ? base64ToUtf8(String(file.content).replace(/\n/g, "")) : ""
  };
}

async function putGithubFile(config, filePath, content, message) {
  const existing = await getGithubFile(config, filePath);
  if (existing && existing.content === content) {
    return { changed: false };
  }
  const endpoint = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${filePath}`;
  await githubRequest({
    method: "PUT",
    endpoint,
    token: config.token,
    body: {
      message,
      content: utf8ToBase64(content),
      branch: config.branch || "main",
      ...(existing?.sha ? { sha: existing.sha } : {})
    }
  });
  return { changed: true, existed: Boolean(existing) };
}

function recordsFromMap(map) {
  return Object.entries(map || {}).map(([backupId, entry]) => {
    const timestamp = String(entry.timestamp || "");
    const dayKey = /^\d{4}-\d{2}-\d{2}/.test(timestamp) ? timestamp.slice(0, 10) : "";
    return {
      backupId,
      company: entry.company || "Unknown Company",
      position: entry.position || "Untitled Position",
      timestamp,
      dayKey,
      byCompanyPath: entry.byCompanyPath,
      byDatePath: entry.byDatePath
    };
  });
}

function buildIndexesFromResolvedMap(resolvedMap, generatedAt) {
  const records = recordsFromMap(resolvedMap);
  const companies = new Map();
  const positions = new Map();
  const dates = new Map();

  records.forEach((record) => {
    if (!companies.has(record.company)) {
      companies.set(record.company, new Map());
    }
    const positionMap = companies.get(record.company);
    if (!positionMap.has(record.position)) {
      positionMap.set(record.position, []);
    }
    positionMap.get(record.position).push({
      id: record.backupId,
      timestamp: record.timestamp,
      path: record.byCompanyPath
    });

    const posKey = `${record.company}::${record.position}`;
    if (!positions.has(posKey)) {
      positions.set(posKey, { company: record.company, position: record.position, entries: [] });
    }
    positions.get(posKey).entries.push({
      id: record.backupId,
      date: record.dayKey,
      path: record.byCompanyPath
    });

    if (!dates.has(record.dayKey)) {
      dates.set(record.dayKey, []);
    }
    dates.get(record.dayKey).push({
      company: record.company,
      position: record.position,
      id: record.backupId,
      path: record.byDatePath
    });
  });

  return {
    companies: {
      generatedAt,
      companies: Array.from(companies.entries()).map(([name, posMap]) => ({
        name,
        positions: Array.from(posMap.entries()).map(([positionName, entries]) => ({
          name: positionName,
          count: entries.length,
          entries
        }))
      }))
    },
    positions: {
      generatedAt,
      positions: Array.from(positions.values())
    },
    dates: {
      generatedAt,
      dates: Array.from(dates.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, entries]) => ({ date, entries }))
    }
  };
}

async function runGithubBackupUpsert(payload) {
  const config = payload?.config || {};
  const bundle = payload?.bundle || {};
  if (!config.token || !config.owner || !config.repo) {
    throw new Error("GitHub backup requires token, owner, and repo.");
  }
  if (!Array.isArray(bundle.files)) {
    throw new Error("Invalid bundle payload.");
  }

  const fileMap = new Map();
  bundle.files.forEach((file) => {
    if (file?.path && typeof file.content === "string") {
      fileMap.set(file.path, file.content);
    }
  });

  let incomingMap = bundle.backupIdMap;
  if (!incomingMap) {
    const mapFile = fileMap.get("indexes/backup-id-map.json");
    if (mapFile) {
      const parsed = JSON.parse(mapFile);
      incomingMap = parsed?.map || {};
    }
  }
  if (!incomingMap || typeof incomingMap !== "object") {
    throw new Error("Bundle is missing backup identity map.");
  }

  const existingMapFile = await getGithubFile(config, "indexes/backup-id-map.json");
  const existingMap = existingMapFile ? (JSON.parse(existingMapFile.content)?.map || {}) : {};

  const summary = { created: 0, updated: 0, unchanged: 0, deleted: 0 };
  const resolvedMap = {};
  const commitMessage = `[Backup] ${new Date().toISOString()} (${bundle.profile || "sanitized"})`;

  for (const [backupId, incoming] of Object.entries(incomingMap)) {
    const previous = existingMap[backupId];
    const incomingCompanyPath = incoming.byCompanyPath;
    const incomingDatePath = incoming.byDatePath;
    const markdownContent = fileMap.get(incomingCompanyPath) || fileMap.get(incomingDatePath);
    if (!markdownContent) {
      continue;
    }

    const targetCompanyPath = previous?.byCompanyPath || incomingCompanyPath;
    const targetDatePath = previous?.byDatePath || incomingDatePath;

    const companyWrite = await putGithubFile(config, targetCompanyPath, markdownContent, commitMessage);
    const dateWrite = await putGithubFile(config, targetDatePath, markdownContent, commitMessage);

    if (!previous) {
      summary.created += 1;
    } else if (companyWrite.changed || dateWrite.changed) {
      summary.updated += 1;
    } else {
      summary.unchanged += 1;
    }

    resolvedMap[backupId] = {
      ...incoming,
      byCompanyPath: targetCompanyPath,
      byDatePath: targetDatePath
    };
  }

  const generatedAt = new Date().toISOString();
  const indexes = buildIndexesFromResolvedMap(resolvedMap, generatedAt);
  await putGithubFile(config, "indexes/backup-id-map.json", JSON.stringify({ generatedAt, map: resolvedMap }, null, 2), commitMessage);
  await putGithubFile(config, "indexes/companies.json", JSON.stringify(indexes.companies, null, 2), commitMessage);
  await putGithubFile(config, "indexes/positions.json", JSON.stringify(indexes.positions, null, 2), commitMessage);
  await putGithubFile(config, "indexes/dates.json", JSON.stringify(indexes.dates, null, 2), commitMessage);

  // Persist non-scrap files from bundle (canonical payload and manifest).
  for (const [path, content] of fileMap.entries()) {
    if (path.startsWith("by-company/") || path.startsWith("by-date/") || path.startsWith("indexes/")) {
      continue;
    }
    await putGithubFile(config, path, content, commitMessage);
  }

  const backupStatus = {
    ok: true,
    at: new Date().toISOString(),
    summary,
    repo: `${config.owner}/${config.repo}`,
    branch: config.branch || "main"
  };
  const latestCommitResp = await githubRequest({
    endpoint: `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/commits/${encodeURIComponent(config.branch || "main")}`,
    token: config.token
  });
  backupStatus.latestCommitSha = latestCommitResp?.data?.sha || null;
  backupStatus.latestCommitDate = latestCommitResp?.data?.commit?.author?.date || null;

  await chrome.storage.local.set({ lastGithubBackupStatus: backupStatus });
  return backupStatus;
}

async function githubDeviceRequest(endpoint, body) {
  const form = new URLSearchParams();
  Object.entries(body || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      form.set(key, String(value));
    }
  });

  const response = await fetch(`https://github.com${endpoint}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error_description || data.error || "GitHub OAuth request failed.");
  }
  if (data.error) {
    throw new Error(data.error_description || data.error);
  }
  return data;
}

function createFlowId() {
  return `flow_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function startGithubDeviceFlow(clientId) {
  const payload = await githubDeviceRequest("/login/device/code", {
    client_id: clientId,
    scope: "repo"
  });

  const flowId = createFlowId();
  const flow = {
    id: flowId,
    clientId,
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    verificationUriComplete: payload.verification_uri_complete || null,
    interval: Math.max(2, Number(payload.interval || 5)),
    expiresAt: Date.now() + Number(payload.expires_in || 900) * 1000,
    state: "pending",
    token: null,
    message: null,
    lastPollAt: 0
  };
  githubOAuthFlows.set(flowId, flow);
  await chrome.storage.local.set({ [GITHUB_OAUTH_FLOW_KEY]: flow });
  return flow;
}

async function pollGithubDeviceFlow(flow) {
  if (flow.state !== "pending") {
    await chrome.storage.local.set({ [GITHUB_OAUTH_FLOW_KEY]: flow });
    return flow;
  }
  if (Date.now() > flow.expiresAt) {
    flow.state = "expired";
    flow.message = "OAuth device code expired.";
    await chrome.storage.local.set({ [GITHUB_OAUTH_FLOW_KEY]: flow });
    return flow;
  }
  if (Date.now() - flow.lastPollAt < flow.interval * 1000) {
    return flow;
  }

  flow.lastPollAt = Date.now();
  try {
    const tokenResp = await githubDeviceRequest("/login/oauth/access_token", {
      client_id: flow.clientId,
      device_code: flow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    });

    if (tokenResp.access_token) {
      flow.state = "authorized";
      flow.token = tokenResp.access_token;
      flow.message = "Authorized.";
      await chrome.storage.local.set({ [GITHUB_OAUTH_FLOW_KEY]: flow });
      return flow;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "OAuth polling error.";
    if (/authorization_pending/i.test(message)) {
      flow.state = "pending";
      await chrome.storage.local.set({ [GITHUB_OAUTH_FLOW_KEY]: flow });
      return flow;
    }
    if (/slow_down/i.test(message)) {
      flow.interval += 2;
      flow.state = "pending";
      return flow;
    }
    if (/expired_token/i.test(message)) {
      flow.state = "expired";
      flow.message = "OAuth device code expired.";
      await chrome.storage.local.set({ [GITHUB_OAUTH_FLOW_KEY]: flow });
      return flow;
    }
    flow.state = "failed";
    flow.message = message;
    await chrome.storage.local.set({ [GITHUB_OAUTH_FLOW_KEY]: flow });
    return flow;
  }

  await chrome.storage.local.set({ [GITHUB_OAUTH_FLOW_KEY]: flow });
  return flow;
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

  if (message?.type === "GITHUB_BACKUP_UPSERT") {
    runGithubBackupUpsert(message.payload)
      .then((status) => sendResponse({ ok: true, status, summary: status.summary, repo: status.repo, branch: status.branch }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : "GitHub backup failed.";
        chrome.storage.local.set({
          lastGithubBackupStatus: {
            ok: false,
            at: new Date().toISOString(),
            message: messageText
          }
        });
        sendResponse({ ok: false, message: messageText });
      });
    return true;
  }

  if (message?.type === "GET_GITHUB_BACKUP_STATUS") {
    chrome.storage.local.get(["lastGithubBackupStatus"], (data) => {
      sendResponse({ ok: true, status: data.lastGithubBackupStatus || null });
    });
    return true;
  }

  if (message?.type === "GITHUB_OAUTH_DEVICE_START") {
    const clientId = message?.payload?.clientId;
    if (!clientId) {
      sendResponse({ ok: false, message: "Missing client ID." });
      return false;
    }
    startGithubDeviceFlow(clientId)
      .then(async (flow) => {
        try {
          await chrome.tabs.create({ url: flow.verificationUriComplete || flow.verificationUri });
        } catch (_error) {
          // ignore
        }
        sendResponse({
          ok: true,
          flowId: flow.id,
          userCode: flow.userCode,
          verificationUri: flow.verificationUri,
          verificationUriComplete: flow.verificationUriComplete
        });
      })
      .catch((error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "Failed to start OAuth flow." }));
    return true;
  }

  if (message?.type === "GITHUB_OAUTH_DEVICE_STATUS") {
    const flowId = message?.payload?.flowId;
    (async () => {
      let flow = githubOAuthFlows.get(flowId);
      if (!flow) {
        const stored = await chrome.storage.local.get([GITHUB_OAUTH_FLOW_KEY]);
        const persisted = stored?.[GITHUB_OAUTH_FLOW_KEY];
        if (persisted?.id === flowId) {
          flow = persisted;
          githubOAuthFlows.set(flowId, flow);
        }
      }

      if (!flow) {
        sendResponse({ ok: false, message: "OAuth flow not found. Click Connect GitHub OAuth again." });
        return;
      }

      const next = await pollGithubDeviceFlow(flow);
      if (next.state === "authorized" && next.token) {
        await chrome.storage.local.set({ [GITHUB_OAUTH_TOKEN_KEY]: next.token });
        await chrome.storage.local.remove(GITHUB_OAUTH_FLOW_KEY);
        githubOAuthFlows.delete(flowId);
      }

      if (next.state === "failed" || next.state === "expired") {
        await chrome.storage.local.remove(GITHUB_OAUTH_FLOW_KEY);
        githubOAuthFlows.delete(flowId);
      }

        sendResponse({
          ok: true,
          state: next.state,
          token: next.token || null,
          message: next.message || null
        });
    })().catch((error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "OAuth status failed." }));
    return true;
  }
});
