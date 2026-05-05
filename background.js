async function setLastCaptureStatus(status) {
  await chrome.storage.local.set({ lastCaptureStatus: { ...status, at: new Date().toISOString() } });
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

async function captureFromTab(tab, reason = "manual") {
  if (!tab || typeof tab.id !== "number") {
    const error = { ok: false, code: "NO_ACTIVE_TAB", message: "No active tab found." };
    await setLastCaptureStatus({ ...error, reason });
    return error;
  }

  try {
    const data = await scrapeTab(tab.id);
    const result = {
      ok: true,
      code: "CAPTURED",
      message: "Capture ready.",
      reason,
      data: {
        title: data.title || tab.title || "Untitled Page",
        cleanedText: data.cleanedText || "",
        url: tab.url || ""
      }
    };
    await setLastCaptureStatus(result);
    return result;
  } catch (error) {
    const failure = {
      ok: false,
      code: "SCRAPE_FAILED",
      message: error instanceof Error ? error.message : "Capture failed.",
      reason
    };
    await setLastCaptureStatus(failure);
    return failure;
  }
}

async function captureActiveTab(reason = "manual") {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return captureFromTab(tabs[0], reason);
}

chrome.action.onClicked.addListener(async (tab) => {
  await captureFromTab(tab, "action_click");
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "trigger-action") {
    return;
  }
  await captureActiveTab("shortcut");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CAPTURE_ACTIVE_TAB") {
    captureActiveTab(message.reason || "popup")
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({ ok: false, code: "CAPTURE_FAILED", message: error instanceof Error ? error.message : "Capture failed." });
      });
    return true;
  }

  if (message?.type === "GET_LAST_CAPTURE_STATUS") {
    chrome.storage.local.get("lastCaptureStatus", (data) => {
      sendResponse({ ok: true, status: data.lastCaptureStatus || null });
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
        await chrome.sidePanel.setOptions({
          tabId: tab.id,
          path: "options.html",
          enabled: true
        });
        await chrome.sidePanel.open({ tabId: tab.id });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : "Unable to open side panel."
        });
      }
    });
    return true;
  }
});
