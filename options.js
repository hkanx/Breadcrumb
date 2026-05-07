const SCRAP_STATUS = ["saved", "applied", "interviewing", "offer", "rejected"];
const THEME_KEY = "breadcrumb-vault-theme";
const GITHUB_BACKUP_KEY = "githubBackupSettings";
const GITHUB_OAUTH_TOKEN_KEY = "githubOAuthToken";

const state = {
  companies: [],
  filteredItems: [],
  selectedItem: null,
  searchTerm: "",
  velocity: [],
  mode: "company",
  metaMode: "all",
  editingKey: null,
  savingKey: null,
  diagnostics: {
    lastStatus: null,
    lastDraft: null
  }
};

function formatDate(isoDate) {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return isoDate;
  }
  return parsed.toLocaleString();
}

function applyTheme(theme) {
  const body = document.body;
  body.classList.remove("theme-light", "theme-night");
  body.classList.add(theme === "night" ? "theme-night" : "theme-light");

  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.textContent = theme === "night" ? "Light Mode" : "Night Mode";
  }

  document.querySelectorAll(".theme-cat").forEach((img) => {
    img.src = "assets/pixel/cat-universal-32.png";
  });
}

function escapeMarkdown(text) {
  return String(text || "").replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

function normalizeForFileName(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function keyForScrap(companyName, positionName, timestamp) {
  return `${companyName}::${positionName}::${timestamp}`;
}

function toMarkdown(companyName, position) {
  const lines = [`# ${escapeMarkdown(companyName)} - ${escapeMarkdown(position.name)}`, ""];

  (position.scraps || []).forEach((scrap, index) => {
    lines.push(`## Scrap ${index + 1}`);
    lines.push(`- Timestamp: ${scrap.timestamp}`);
    lines.push(`- URL: ${scrap.url || "N/A"}`);
    lines.push(`- Status: ${scrap.status || "saved"}`);
    lines.push(`- Favorite: ${scrap.favorite ? "yes" : "no"}`);
    if ((scrap.tags || []).length) {
      lines.push(`- Tags: ${(scrap.tags || []).join(", ")}`);
    }
    if (scrap.note) {
      lines.push(`- Note: ${escapeMarkdown(scrap.note)}`);
    }
    if (scrap.lastEditedAt) {
      lines.push(`- Last edited: ${scrap.lastEditedAt}`);
    }
    lines.push("");
    lines.push("```text");
    lines.push(formatReadableTextForView(scrap.rawText || ""));
    lines.push("```");
    lines.push("");
  });

  return lines.join("\n");
}

function formatReadableTextForView(rawText) {
  if (window.BreadcrumbStorage?.formatReadableText) {
    return window.BreadcrumbStorage.formatReadableText(rawText || "");
  }
  return String(rawText || "").trim();
}

function downloadTextFile(filename, content, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setGithubStatus(message, type = "") {
  const statusEl = document.getElementById("gh-backup-status");
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function setDeviceCode(code) {
  const box = document.getElementById("gh-device-code-box");
  const value = document.getElementById("gh-device-code-value");
  if (!box || !value) {
    return;
  }
  if (!code) {
    box.hidden = true;
    value.textContent = "";
    return;
  }
  value.textContent = code;
  box.hidden = false;
}

function getGithubConfigFromInputs() {
  return {
    clientId: document.getElementById("gh-client-id")?.value.trim() || "",
    token: document.getElementById("gh-token")?.value.trim() || "",
    owner: document.getElementById("gh-owner")?.value.trim() || "",
    repo: document.getElementById("gh-repo")?.value.trim() || "",
    branch: document.getElementById("gh-branch")?.value.trim() || "main"
  };
}

async function loadGithubSettings() {
  const data = await chrome.storage.local.get([GITHUB_BACKUP_KEY, GITHUB_OAUTH_TOKEN_KEY]);
  const config = data?.[GITHUB_BACKUP_KEY] || {};
  const oauthToken = data?.[GITHUB_OAUTH_TOKEN_KEY] || "";
  const tokenInput = document.getElementById("gh-token");
  const clientIdInput = document.getElementById("gh-client-id");
  const ownerInput = document.getElementById("gh-owner");
  const repoInput = document.getElementById("gh-repo");
  const branchInput = document.getElementById("gh-branch");

  if (clientIdInput) {
    clientIdInput.value = config.clientId || "";
  }
  if (tokenInput) {
    tokenInput.value = config.token || oauthToken || "";
  }
  if (ownerInput) {
    ownerInput.value = config.owner || "";
  }
  if (repoInput) {
    repoInput.value = config.repo || "";
  }
  if (branchInput) {
    branchInput.value = config.branch || "main";
  }
}

async function resolveGithubConfigForBackup() {
  const config = getGithubConfigFromInputs();
  if (config.token) {
    return config;
  }
  const data = await chrome.storage.local.get([GITHUB_OAUTH_TOKEN_KEY, GITHUB_BACKUP_KEY]);
  const oauthToken = data?.[GITHUB_OAUTH_TOKEN_KEY] || "";
  const saved = data?.[GITHUB_BACKUP_KEY] || {};
  return {
    clientId: config.clientId || saved.clientId || "",
    token: oauthToken || saved.token || "",
    owner: config.owner || saved.owner || "",
    repo: config.repo || saved.repo || "",
    branch: config.branch || saved.branch || "main"
  };
}

async function runGithubOAuthConnect() {
  const clientId = document.getElementById("gh-client-id")?.value.trim() || "";
  if (!clientId) {
    setGithubStatus("Enter GitHub OAuth App Client ID first.", "error");
    return;
  }

  setGithubStatus("Starting GitHub OAuth device flow...", "");
  const start = await chrome.runtime.sendMessage({ type: "GITHUB_OAUTH_DEVICE_START", payload: { clientId } });
  if (!start?.ok) {
    setGithubStatus(start?.message || "Failed to start OAuth.", "error");
    setDeviceCode("");
    return;
  }

  setDeviceCode(start.userCode || "");
  setGithubStatus(`Open GitHub and enter code: ${start.userCode}`, "");
  const maxPolls = 120;
  for (let i = 0; i < maxPolls; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const status = await chrome.runtime.sendMessage({ type: "GITHUB_OAUTH_DEVICE_STATUS", payload: { flowId: start.flowId } });
    if (!status?.ok) {
      setGithubStatus(status?.message || "OAuth failed.", "error");
      setDeviceCode(start.userCode || "");
      return;
    }
    if (status.state === "pending") {
      continue;
    }
    if (status.state === "authorized") {
      const tokenInput = document.getElementById("gh-token");
      if (tokenInput) {
        tokenInput.value = status.token || "";
      }
      await chrome.storage.local.set({ [GITHUB_OAUTH_TOKEN_KEY]: status.token || "" });
      const config = getGithubConfigFromInputs();
      await chrome.storage.local.set({ [GITHUB_BACKUP_KEY]: config });
      setGithubStatus("GitHub OAuth connected and token saved.", "success");
      setDeviceCode("");
      return;
    }
    setGithubStatus(status.message || "OAuth failed.", "error");
    setDeviceCode(start.userCode || "");
    return;
  }

  setGithubStatus("OAuth timed out. Try again.", "error");
  setDeviceCode(start.userCode || "");
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

function isValidUrl(url) {
  if (!url) {
    return true;
  }
  try {
    new URL(url);
    return true;
  } catch (_error) {
    return false;
  }
}

function matchesMetaFilter(scrap) {
  if (state.metaMode === "all") {
    return true;
  }
  if (state.metaMode === "favorite") {
    return Boolean(scrap.favorite);
  }
  return ["applied", "interviewing", "offer"].includes(scrap.status || "saved");
}

function matchesSearchText(text) {
  return text.toLowerCase().includes(state.searchTerm);
}

function scrapBlob(companyName, positionName, scrap) {
  return `${companyName} ${positionName} ${scrap.url || ""} ${scrap.note || ""} ${scrap.rawText || ""} ${scrap.status || ""} ${(scrap.tags || []).join(" ")} ${scrap.favorite ? "favorite" : ""}`;
}

function getVisibleScraps() {
  const result = [];
  state.companies.forEach((company) => {
    (company.positions || []).forEach((position) => {
      (position.scraps || []).forEach((scrap) => {
        if (!matchesMetaFilter(scrap)) {
          return;
        }
        if (state.searchTerm && !matchesSearchText(scrapBlob(company.name, position.name, scrap).toLowerCase())) {
          return;
        }
        result.push({ companyName: company.name, positionName: position.name, scrap });
      });
    });
  });
  return result;
}

function getPositions() {
  const entries = [];
  state.companies.forEach((company) => {
    (company.positions || []).forEach((position) => {
      const hasVisible = (position.scraps || []).some((scrap) => {
        if (!matchesMetaFilter(scrap)) {
          return false;
        }
        if (!state.searchTerm) {
          return true;
        }
        return matchesSearchText(scrapBlob(company.name, position.name, scrap).toLowerCase());
      });

      if (hasVisible) {
        entries.push({ type: "position", companyName: company.name, positionName: position.name, position });
      }
    });
  });
  return entries;
}

function getRecentScraps() {
  const scraps = getVisibleScraps().map((entry) => ({ ...entry, type: "recent" }));
  scraps.sort((a, b) => new Date(b.scrap.timestamp).getTime() - new Date(a.scrap.timestamp).getTime());
  return scraps;
}

function computeFilteredItems() {
  if (state.mode === "company") {
    state.filteredItems = state.companies
      .filter((company) => {
        const companyMatches = !state.searchTerm || matchesSearchText(company.name.toLowerCase());

        const hasVisible = (company.positions || []).some((position) =>
          (position.scraps || []).some((scrap) => {
            if (!matchesMetaFilter(scrap)) {
              return false;
            }
            if (!state.searchTerm) {
              return true;
            }
            return companyMatches || matchesSearchText(scrapBlob(company.name, position.name, scrap).toLowerCase());
          })
        );

        return hasVisible;
      })
      .map((company) => ({ type: "company", companyName: company.name }));
    return;
  }

  if (state.mode === "position") {
    state.filteredItems = getPositions();
    return;
  }

  state.filteredItems = getRecentScraps();
}

function ensureSelectedItem() {
  if (!state.selectedItem) {
    state.selectedItem = state.filteredItems[0] || null;
    return;
  }

  const selectedKey = JSON.stringify(state.selectedItem);
  const found = state.filteredItems.some((item) => JSON.stringify(item) === selectedKey);
  if (!found) {
    state.selectedItem = state.filteredItems[0] || null;
  }
}

function renderVelocityChart() {
  const chart = document.getElementById("velocity-chart");
  const summary = document.getElementById("velocity-summary");
  const points = state.velocity;

  if (!chart || !summary) {
    return;
  }

  chart.innerHTML = "";

  if (!Array.isArray(points) || points.length === 0) {
    summary.textContent = "No data yet";
    return;
  }

  const total = points.reduce((sum, item) => sum + item.count, 0);
  const avg = (total / points.length).toFixed(2);
  summary.textContent = `${total} scraps in ${points.length} days (${avg}/day)`;

  points.forEach((point) => {
    const day = document.createElement("div");
    day.className = "velocity-day";
    day.title = `${point.date}: ${point.count} scrap${point.count === 1 ? "" : "s"}`;

    const latteCount = Math.floor(point.count / 5);
    const toastCount = point.count % 5;

    for (let i = 0; i < latteCount; i += 1) {
      const latte = document.createElement("img");
      latte.className = "velocity-latte";
      latte.src = "assets/pixel/latte-24.png";
      latte.alt = "";
      latte.width = 16;
      latte.height = 16;
      day.append(latte);
    }

    for (let i = 0; i < toastCount; i += 1) {
      const toast = document.createElement("img");
      toast.className = "velocity-toast";
      toast.src = "assets/pixel/toast-24.png";
      toast.alt = "";
      toast.width = 16;
      toast.height = 16;
      day.append(toast);
    }

    chart.append(day);
  });
}

function renderDiagnostics() {
  const summaryEl = document.getElementById("diagnostic-summary");
  const textEl = document.getElementById("diagnostic-text");

  if (!summaryEl || !textEl) {
    return;
  }

  const totalScraps = state.companies.reduce((sum, company) => {
    return sum + (company.positions || []).reduce((posSum, position) => posSum + (position.scraps || []).length, 0);
  }, 0);

  const topBuckets = state.velocity
    .filter((point) => point.count > 0)
    .slice(-5)
    .map((point) => `${point.date}:${point.count}`)
    .join(" | ");

  const lastStatus = state.diagnostics.lastStatus;
  const statusText = lastStatus ? `${lastStatus.code || "UNKNOWN"} (${(lastStatus.confidence || 0) * 100}%)` : "No capture status yet";
  summaryEl.textContent = `${totalScraps} scraps | ${statusText}`;

  textEl.textContent = `Last message: ${lastStatus?.message || "N/A"}\nLast draft: ${state.diagnostics.lastDraft?.reason || "none"}\nVelocity buckets: ${topBuckets || "none"}`;
}

function renderSidebar() {
  const list = document.getElementById("company-list");
  list.innerHTML = "";

  if (state.filteredItems.length === 0) {
    list.innerHTML = '<p class="empty-state">No saved listings match this filter.</p>';
    return;
  }

  state.filteredItems.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    const selected = JSON.stringify(item) === JSON.stringify(state.selectedItem);
    button.className = `company-button ${selected ? "active" : ""}`.trim();

    if (item.type === "company") {
      button.textContent = item.companyName;
    } else if (item.type === "position") {
      button.textContent = `${item.companyName} | ${item.positionName}`;
    } else {
      button.textContent = `${item.companyName} | ${item.positionName} | ${formatDate(item.scrap.timestamp)}`;
    }

    button.addEventListener("click", () => {
      state.selectedItem = item;
      renderSidebar();
      renderMainView();
    });

    list.append(button);
  });
}

function createStatusSelect(scrap, onChange) {
  const select = document.createElement("select");
  SCRAP_STATUS.forEach((status) => {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = status;
    if ((scrap.status || "saved") === status) {
      option.selected = true;
    }
    select.append(option);
  });
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function createScrapView({ companyName, positionName, scrap }) {
  const item = document.createElement("section");
  item.className = "scrap-item";

  const key = keyForScrap(companyName, positionName, scrap.timestamp);
  const isEditing = state.editingKey === key;
  const isSaving = state.savingKey === key;

  const meta = document.createElement("div");
  meta.className = "scrap-meta";
  const editedText = scrap.lastEditedAt ? ` | Edited: ${formatDate(scrap.lastEditedAt)}` : "";
  meta.textContent = `${formatDate(scrap.timestamp)}${scrap.url ? ` | ${scrap.url}` : ""}${editedText} | confidence ${Math.round((scrap.confidence || 0) * 100)}%`;

  const controls = document.createElement("div");
  controls.className = "scrap-controls";

  const favoriteButton = document.createElement("button");
  favoriteButton.className = "btn-secondary";
  favoriteButton.type = "button";
  favoriteButton.textContent = scrap.favorite ? "★ Favorite" : "☆ Favorite";
  favoriteButton.addEventListener("click", async () => {
    await window.BreadcrumbStorage.toggleScrapFavorite(companyName, positionName, scrap.timestamp, !scrap.favorite);
    await loadCompanies();
  });

  const statusSelect = createStatusSelect(scrap, async (status) => {
    await window.BreadcrumbStorage.setScrapStatus(companyName, positionName, scrap.timestamp, status);
    await loadCompanies();
  });

  const editButton = document.createElement("button");
  editButton.className = "btn-secondary";
  editButton.type = "button";
  editButton.textContent = isEditing ? "Cancel" : "Edit";
  editButton.disabled = isSaving;
  editButton.addEventListener("click", () => {
    state.editingKey = isEditing ? null : key;
    renderMainView();
  });

  const deleteButton = document.createElement("button");
  deleteButton.className = "btn-danger";
  deleteButton.type = "button";
  deleteButton.textContent = "Delete";
  deleteButton.disabled = isSaving;
  deleteButton.addEventListener("click", async () => {
    if (!window.confirm("Delete this saved scrap? This cannot be undone.")) {
      return;
    }

    await window.BreadcrumbStorage.deleteScrap(companyName, positionName, scrap.timestamp);
    state.editingKey = null;
    await loadCompanies();
  });

  const copyButton = document.createElement("button");
  copyButton.className = "btn-secondary";
  copyButton.type = "button";
  copyButton.textContent = "Copy Description";
  copyButton.disabled = isSaving;
  copyButton.addEventListener("click", async () => {
    const summary = `${companyName} | ${positionName}\n${scrap.url || ""}\n${scrap.note || ""}\n\n${formatReadableTextForView(scrap.rawText || "")}`;
    await copyText(summary);
  });

  controls.append(favoriteButton, statusSelect, editButton, copyButton, deleteButton);
  item.append(meta, controls);

  if (!isEditing) {
    const tagLine = document.createElement("p");
    tagLine.className = "scrap-meta";
    tagLine.textContent = `Tags: ${(scrap.tags || []).join(", ") || "none"}`;
    item.append(tagLine);

    const text = document.createElement("div");
    text.className = "scrap-text";
    const readable = formatReadableTextForView(scrap.rawText || "");
    const shortened = readable.slice(0, 1600);
    const preview = shortened + (readable.length > 1600 ? " ..." : "");
    const paragraphs = preview
      .split(/\n{2,}/g)
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (paragraphs.length <= 1) {
      text.textContent = preview;
    } else {
      paragraphs.forEach((paragraph) => {
        const paragraphEl = document.createElement("p");
        paragraphEl.className = "scrap-paragraph";
        paragraphEl.textContent = paragraph;
        text.append(paragraphEl);
      });
    }
    item.append(text);

    if (scrap.note) {
      const note = document.createElement("p");
      note.className = "scrap-meta";
      note.textContent = `Note: ${scrap.note}`;
      item.append(note);
    }

    return item;
  }

  const form = document.createElement("form");
  form.className = "edit-form";

  const positionInput = document.createElement("input");
  positionInput.name = "position";
  positionInput.value = positionName;
  positionInput.placeholder = "Position";

  const urlInput = document.createElement("input");
  urlInput.name = "url";
  urlInput.value = scrap.url || "";
  urlInput.placeholder = "https://example.com/job";

  const tagsInput = document.createElement("input");
  tagsInput.name = "tags";
  tagsInput.value = (scrap.tags || []).join(", ");
  tagsInput.placeholder = "comma,separated,tags";

  const noteInput = document.createElement("textarea");
  noteInput.name = "note";
  noteInput.rows = 2;
  noteInput.placeholder = "Note";
  noteInput.value = scrap.note || "";

  const textInput = document.createElement("textarea");
  textInput.name = "rawText";
  textInput.rows = 8;
  textInput.value = scrap.rawText || "";

  const row = document.createElement("div");
  row.className = "edit-actions";

  const saveButton = document.createElement("button");
  saveButton.className = "btn-primary";
  saveButton.type = "submit";
  saveButton.textContent = isSaving ? "Saving..." : "Save";
  saveButton.disabled = isSaving;

  const cancelButton = document.createElement("button");
  cancelButton.className = "btn-secondary";
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.disabled = isSaving;
  cancelButton.addEventListener("click", () => {
    state.editingKey = null;
    renderMainView();
  });

  row.append(saveButton, cancelButton);

  form.append(positionInput, urlInput, tagsInput, noteInput, textInput, row);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const nextPosition = positionInput.value.trim();
    const nextUrl = urlInput.value.trim();
    const nextNote = noteInput.value;
    const nextRawText = textInput.value;
    const nextTags = tagsInput.value.split(",").map((item) => item.trim()).filter(Boolean);

    if (!nextPosition) {
      window.alert("Position is required.");
      return;
    }

    if (!nextRawText.trim()) {
      window.alert("Scrap text cannot be empty.");
      return;
    }

    if (!isValidUrl(nextUrl)) {
      window.alert("Please enter a valid URL.");
      return;
    }

    state.savingKey = key;
    renderMainView();

    try {
      if (nextPosition !== positionName) {
        const confirmed = window.confirm(`Move this scrap from '${positionName}' to '${nextPosition}'?`);
        if (!confirmed) {
          state.savingKey = null;
          renderMainView();
          return;
        }

        const moved = await window.BreadcrumbStorage.moveScrapToPosition(companyName, positionName, nextPosition, scrap.timestamp);
        if (!moved) {
          throw new Error("Unable to move scrap to the new position.");
        }
      }

      const updated = await window.BreadcrumbStorage.updateScrap(companyName, nextPosition, scrap.timestamp, {
        rawText: nextRawText,
        note: nextNote,
        url: nextUrl,
        tags: nextTags
      });

      if (!updated) {
        throw new Error("Unable to save edits for this scrap.");
      }

      state.editingKey = null;
      state.savingKey = null;
      await loadCompanies();
    } catch (error) {
      state.savingKey = null;
      window.alert(error instanceof Error ? error.message : "Failed to save edits.");
      renderMainView();
    }
  });

  item.append(form);
  return item;
}

function renderPositionCard(companyName, position) {
  const card = document.createElement("article");
  card.className = "position-card";

  const header = document.createElement("div");
  header.className = "position-header";

  const heading = document.createElement("h3");
  heading.className = "position-title";
  heading.textContent = position.name;

  const actions = document.createElement("div");
  actions.className = "position-actions";

  const copyButton = document.createElement("button");
  copyButton.className = "btn-secondary";
  copyButton.type = "button";
  copyButton.textContent = "Copy Description";
  copyButton.addEventListener("click", async () => {
    const markdown = toMarkdown(companyName, position);
    await copyText(markdown);
  });

  const exportButton = document.createElement("button");
  exportButton.className = "btn-secondary";
  exportButton.type = "button";
  exportButton.textContent = "Export to Markdown";
  exportButton.addEventListener("click", () => {
    const markdown = toMarkdown(companyName, position);
    const fileName = `${normalizeForFileName(companyName)}-${normalizeForFileName(position.name)}.md`;
    downloadTextFile(fileName, markdown, "text/markdown;charset=utf-8");
  });

  actions.append(copyButton, exportButton);
  header.append(heading, actions);

  const scrapList = document.createElement("div");
  scrapList.className = "scrap-list";
  (position.scraps || [])
    .filter((scrap) => matchesMetaFilter(scrap))
    .filter((scrap) => !state.searchTerm || matchesSearchText(scrapBlob(companyName, position.name, scrap).toLowerCase()))
    .forEach((scrap) => {
      scrapList.append(createScrapView({ companyName, positionName: position.name, scrap }));
    });

  card.append(header, scrapList);
  return card;
}

function findCompanyByName(name) {
  return state.companies.find((company) => company.name === name) || null;
}

function renderMainView() {
  const title = document.getElementById("company-title");
  const view = document.getElementById("positions-view");

  if (!state.selectedItem) {
    title.textContent = "Select a company";
    view.innerHTML = '<p class="empty-state">Choose an item from the left to inspect saved listings.</p>';
    return;
  }

  view.innerHTML = "";

  if (state.selectedItem.type === "company") {
    const company = findCompanyByName(state.selectedItem.companyName);
    title.textContent = company?.name || "Company";

    if (!company || !Array.isArray(company.positions) || company.positions.length === 0) {
      view.innerHTML = '<p class="empty-state">No positions captured for this company yet.</p>';
      return;
    }

    company.positions.forEach((position) => view.append(renderPositionCard(company.name, position)));
    return;
  }

  if (state.selectedItem.type === "position") {
    const { companyName, positionName } = state.selectedItem;
    const company = findCompanyByName(companyName);
    const position = (company?.positions || []).find((item) => item.name === positionName);

    title.textContent = `${companyName} | ${positionName}`;

    if (!position) {
      view.innerHTML = '<p class="empty-state">Position no longer exists.</p>';
      return;
    }

    view.append(renderPositionCard(companyName, position));
    return;
  }

  const { companyName, positionName, scrap } = state.selectedItem;
  title.textContent = `Recent: ${companyName} | ${positionName}`;
  const container = document.createElement("article");
  container.className = "position-card";
  const list = document.createElement("div");
  list.className = "scrap-list";
  list.append(createScrapView({ companyName, positionName, scrap }));
  container.append(list);
  view.append(container);
}

function applyFilterMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".btn-filter[data-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  computeFilteredItems();
  ensureSelectedItem();
  renderSidebar();
  renderMainView();
}

function applyMetaFilter(meta) {
  state.metaMode = meta;
  document.querySelectorAll(".btn-filter[data-meta]").forEach((button) => {
    button.classList.toggle("active", button.dataset.meta === meta);
  });
  computeFilteredItems();
  ensureSelectedItem();
  renderSidebar();
  renderMainView();
}

function applySearch(term) {
  state.searchTerm = term.trim().toLowerCase();
  computeFilteredItems();
  ensureSelectedItem();
  renderSidebar();
  renderMainView();
}

async function refreshDiagnosticsFromBackground() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_LAST_CAPTURE_STATUS" });
    if (response?.ok) {
      state.diagnostics.lastStatus = response.status || null;
      state.diagnostics.lastDraft = response.draft || null;
    }
  } catch (_error) {
    // ignore
  }
}

async function loadCompanies() {
  state.companies = await window.BreadcrumbStorage.getAlphabeticalCompanies();
  state.velocity = await window.BreadcrumbStorage.getDailyApplicationVelocity(14);
  await refreshDiagnosticsFromBackground();
  renderVelocityChart();
  renderDiagnostics();
  computeFilteredItems();
  ensureSelectedItem();
  renderSidebar();
  renderMainView();
}

async function bulkApplyVisible(fn) {
  const visible = getVisibleScraps();
  for (const entry of visible) {
    await fn(entry);
  }
  await loadCompanies();
}

function wireToolbarActions() {
  document.getElementById("bulk-favorite")?.addEventListener("click", async () => {
    await bulkApplyVisible(async ({ companyName, positionName, scrap }) => {
      await window.BreadcrumbStorage.toggleScrapFavorite(companyName, positionName, scrap.timestamp, true);
    });
  });

  document.getElementById("bulk-status-applied")?.addEventListener("click", async () => {
    await bulkApplyVisible(async ({ companyName, positionName, scrap }) => {
      await window.BreadcrumbStorage.setScrapStatus(companyName, positionName, scrap.timestamp, "applied");
    });
  });

  document.getElementById("bulk-tag-core")?.addEventListener("click", async () => {
    await bulkApplyVisible(async ({ companyName, positionName, scrap }) => {
      const tags = [...(scrap.tags || []), "core"];
      await window.BreadcrumbStorage.setScrapTags(companyName, positionName, scrap.timestamp, tags);
    });
  });

  document.getElementById("bulk-export")?.addEventListener("click", async () => {
    const visible = getVisibleScraps();
    if (!visible.length) {
      window.alert("No visible scraps to export.");
      return;
    }
    const lines = visible
      .map((entry) => `# ${entry.companyName} | ${entry.positionName}\n\n${formatReadableTextForView(entry.scrap.rawText || "")}\n`)
      .join("\n");
    downloadTextFile("breadcrumb-visible-export.md", lines, "text/markdown;charset=utf-8");
  });

  document.getElementById("export-json")?.addEventListener("click", async () => {
    const payload = await window.BreadcrumbStorage.exportVaultJson();
    downloadTextFile("breadcrumb-vault.json", JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
  });

  document.getElementById("export-backup-bundle")?.addEventListener("click", async () => {
    const profile = window.confirm("Export full raw captures? Select Cancel for sanitized backup.") ? "full" : "sanitized";
    const payload = await window.BreadcrumbStorage.exportBackupBundle({ profile });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadTextFile(`breadcrumb-backup-bundle-${profile}-${stamp}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
  });

  document.getElementById("gh-save-connection")?.addEventListener("click", async () => {
    const config = await resolveGithubConfigForBackup();
    if (!config.owner || !config.repo) {
      setGithubStatus("Repo owner and repo name are required.", "error");
      return;
    }
    if (!config.token) {
      setGithubStatus("Connect OAuth or enter a token first.", "error");
      return;
    }
    await chrome.storage.local.set({ [GITHUB_BACKUP_KEY]: config });
    setGithubStatus("GitHub connection saved.", "success");
  });

  document.getElementById("gh-oauth-connect")?.addEventListener("click", async () => {
    try {
      await runGithubOAuthConnect();
    } catch (error) {
      setGithubStatus(error instanceof Error ? error.message : "OAuth failed.", "error");
    }
  });

  document.getElementById("gh-device-code-copy")?.addEventListener("click", async () => {
    const value = document.getElementById("gh-device-code-value")?.textContent || "";
    if (!value) {
      return;
    }
    try {
      await copyText(value);
      setGithubStatus("Device code copied.", "success");
    } catch (_error) {
      setGithubStatus("Unable to copy code.", "error");
    }
  });

  document.getElementById("gh-clear-connection")?.addEventListener("click", async () => {
    await chrome.storage.local.remove([GITHUB_BACKUP_KEY, GITHUB_OAUTH_TOKEN_KEY]);
    await loadGithubSettings();
    setGithubStatus("GitHub connection removed.", "success");
    setDeviceCode("");
  });

  document.getElementById("gh-backup-now")?.addEventListener("click", async () => {
    try {
      const config = await resolveGithubConfigForBackup();
      if (!config.owner || !config.repo) {
        setGithubStatus("Enter repo owner and repo name first.", "error");
        return;
      }
      if (!config.token) {
        setGithubStatus("Connect GitHub OAuth or enter a token first.", "error");
        return;
      }

      setGithubStatus("Running backup...", "");
      const bundle = await window.BreadcrumbStorage.exportBackupBundle({ profile: "sanitized" });
      const response = await chrome.runtime.sendMessage({
        type: "GITHUB_BACKUP_UPSERT",
        payload: { config, bundle }
      });

      if (!response?.ok) {
        setGithubStatus(`Backup failed: ${response?.message || "Unknown error"}`, "error");
        return;
      }

      const s = response.summary || { created: 0, updated: 0, unchanged: 0, deleted: 0 };
      const repo = response.repo || `${config.owner}/${config.repo}`;
      const branch = response.branch || config.branch || "main";
      const sha = response.status?.latestCommitSha ? String(response.status.latestCommitSha).slice(0, 7) : "unknown";
      setGithubStatus(`Backup complete to ${repo}@${branch}: ${s.updated} updated, ${s.created} created, ${s.unchanged} unchanged, ${s.deleted} deleted. Latest commit: ${sha}`, "success");
    } catch (error) {
      setGithubStatus(`Backup failed: ${error instanceof Error ? error.message : "Unknown error"}`, "error");
    }
  });

  document.getElementById("import-json")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await window.BreadcrumbStorage.importVaultJson(payload);
      await loadCompanies();
      window.alert("Vault JSON imported successfully.");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to import JSON.");
    } finally {
      event.target.value = "";
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const savedTheme = localStorage.getItem(THEME_KEY) || "light";
  applyTheme(savedTheme);

  const themeToggle = document.getElementById("theme-toggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const currentNight = document.body.classList.contains("theme-night");
      const next = currentNight ? "light" : "night";
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });
  }

  const cozyStrip = document.getElementById("cozy-strip");
  if (cozyStrip) {
    requestAnimationFrame(() => cozyStrip.classList.add("ready"));
  }

  const searchInput = document.getElementById("global-search");

  searchInput.addEventListener("input", (event) => {
    applySearch(event.target.value || "");
  });

  document.querySelectorAll(".btn-filter[data-mode]").forEach((button) => {
    button.addEventListener("click", () => applyFilterMode(button.dataset.mode));
  });

  document.querySelectorAll(".btn-filter[data-meta]").forEach((button) => {
    button.addEventListener("click", () => applyMetaFilter(button.dataset.meta));
  });

  wireToolbarActions();
  await loadGithubSettings();
  try {
    const statusResp = await chrome.runtime.sendMessage({ type: "GET_GITHUB_BACKUP_STATUS" });
    if (statusResp?.ok && statusResp.status) {
      if (statusResp.status.ok) {
        const s = statusResp.status.summary || { created: 0, updated: 0, unchanged: 0, deleted: 0 };
        const repo = statusResp.status.repo || "unknown-repo";
        const branch = statusResp.status.branch || "main";
        const sha = statusResp.status.latestCommitSha ? String(statusResp.status.latestCommitSha).slice(0, 7) : "unknown";
        setGithubStatus(`Last backup to ${repo}@${branch}: ${s.updated} updated, ${s.created} created, ${s.unchanged} unchanged. Latest commit: ${sha}`, "success");
      } else {
        setGithubStatus(statusResp.status.message || "Last backup failed.", "error");
      }
    }
  } catch (_error) {
    // ignore
  }

  try {
    await loadCompanies();
  } catch (error) {
    const view = document.getElementById("positions-view");
    view.innerHTML = `<p class="empty-state">Unable to load vault: ${error instanceof Error ? error.message : "Unknown error"}</p>`;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "VAULT_DATA_CHANGED") {
    loadCompanies().catch(() => {});
  }
});

window.addEventListener("focus", () => {
  loadCompanies().catch(() => {});
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    loadCompanies().catch(() => {});
  }
});
