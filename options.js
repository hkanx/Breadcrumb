const state = {
  companies: [],
  filteredItems: [],
  selectedItem: null,
  searchTerm: "",
  velocity: [],
  mode: "company",
  editingKey: null,
  savingKey: null
};

function formatDate(isoDate) {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return isoDate;
  }
  return parsed.toLocaleString();
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
    if (scrap.note) {
      lines.push(`- Note: ${escapeMarkdown(scrap.note)}`);
    }
    if (scrap.lastEditedAt) {
      lines.push(`- Last edited: ${scrap.lastEditedAt}`);
    }
    lines.push("");
    lines.push("```text");
    lines.push((scrap.rawText || "").trim());
    lines.push("```");
    lines.push("");
  });

  return lines.join("\n");
}

function downloadMarkdown(filename, content) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

function getPositions() {
  const entries = [];
  state.companies.forEach((company) => {
    (company.positions || []).forEach((position) => {
      entries.push({
        type: "position",
        companyName: company.name,
        positionName: position.name,
        position
      });
    });
  });
  return entries;
}

function getRecentScraps() {
  const scraps = [];
  state.companies.forEach((company) => {
    (company.positions || []).forEach((position) => {
      (position.scraps || []).forEach((scrap) => {
        scraps.push({
          type: "recent",
          companyName: company.name,
          positionName: position.name,
          scrap
        });
      });
    });
  });

  scraps.sort((a, b) => new Date(b.scrap.timestamp).getTime() - new Date(a.scrap.timestamp).getTime());
  return scraps;
}

function matchesSearchText(text) {
  return text.toLowerCase().includes(state.searchTerm);
}

function getCompanySearchBlob(company) {
  const parts = [company.name];
  (company.positions || []).forEach((position) => {
    parts.push(position.name);
    (position.scraps || []).forEach((scrap) => {
      parts.push(scrap.url || "", scrap.note || "", scrap.rawText || "");
    });
  });
  return parts.join(" ").toLowerCase();
}

function computeFilteredItems() {
  if (state.mode === "company") {
    state.filteredItems = state.companies
      .filter((company) => !state.searchTerm || matchesSearchText(getCompanySearchBlob(company)))
      .map((company) => ({ type: "company", companyName: company.name }));
    return;
  }

  if (state.mode === "position") {
    state.filteredItems = getPositions().filter((entry) => {
      if (!state.searchTerm) {
        return true;
      }
      const blob = `${entry.companyName} ${entry.positionName} ${(entry.position.scraps || []).map((scrap) => `${scrap.url || ""} ${scrap.note || ""} ${scrap.rawText || ""}`).join(" ")}`;
      return matchesSearchText(blob.toLowerCase());
    });
    return;
  }

  state.filteredItems = getRecentScraps().filter((entry) => {
    if (!state.searchTerm) {
      return true;
    }
    const blob = `${entry.companyName} ${entry.positionName} ${entry.scrap.url || ""} ${entry.scrap.note || ""} ${entry.scrap.rawText || ""}`;
    return matchesSearchText(blob.toLowerCase());
  });
}

function ensureSelectedItem() {
  if (!state.selectedItem || !state.filteredItems.some((item) => JSON.stringify(item) === JSON.stringify(state.selectedItem))) {
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

  const maxCount = Math.max(...points.map((item) => item.count), 1);
  const total = points.reduce((sum, item) => sum + item.count, 0);
  const avg = (total / points.length).toFixed(2);
  summary.textContent = `${total} scraps in ${points.length} days (${avg}/day)`;

  points.forEach((point) => {
    const bar = document.createElement("div");
    bar.className = "velocity-bar";
    const height = Math.max(8, Math.round((point.count / maxCount) * 56));
    bar.style.height = `${height}px`;
    bar.title = `${point.date}: ${point.count} scrap${point.count === 1 ? "" : "s"}`;
    chart.append(bar);
  });
}

function rebuildVelocityFromCompanies(days = 14) {
  const toLocalDayKey = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };

  const counts = new Map();
  state.companies.forEach((company) => {
    (company.positions || []).forEach((position) => {
      (position.scraps || []).forEach((scrap) => {
        const parsed = new Date(scrap.timestamp);
        const key = Number.isNaN(parsed.getTime()) ? toLocalDayKey(new Date()) : toLocalDayKey(parsed);
        counts.set(key, (counts.get(key) || 0) + 1);
      });
    });
  });

  const output = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    const key = toLocalDayKey(day);
    output.push({ date: key, count: counts.get(key) || 0 });
  }
  return output;
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

function createScrapView({ companyName, positionName, scrap }) {
  const item = document.createElement("section");
  item.className = "scrap-item";

  const key = keyForScrap(companyName, positionName, scrap.timestamp);
  const isEditing = state.editingKey === key;
  const isSaving = state.savingKey === key;

  const meta = document.createElement("div");
  meta.className = "scrap-meta";
  const editedText = scrap.lastEditedAt ? ` | Edited: ${formatDate(scrap.lastEditedAt)}` : "";
  meta.textContent = `${formatDate(scrap.timestamp)}${scrap.url ? ` | ${scrap.url}` : ""}${editedText}`;

  const controls = document.createElement("div");
  controls.className = "scrap-controls";

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
    const confirmed = window.confirm("Delete this saved scrap? This cannot be undone.");
    if (!confirmed) {
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
    const summary = `${companyName} | ${positionName}\n${scrap.url || ""}\n${scrap.note || ""}\n\n${scrap.rawText || ""}`;
    await copyText(summary);
  });

  controls.append(editButton, copyButton, deleteButton);

  item.append(meta, controls);

  if (!isEditing) {
    const text = document.createElement("p");
    text.className = "scrap-text";
    const shortened = (scrap.rawText || "").slice(0, 1600);
    text.textContent = shortened + ((scrap.rawText || "").length > 1600 ? " ..." : "");
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

  form.append(positionInput, urlInput, noteInput, textInput, row);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const nextPosition = positionInput.value.trim();
    const nextUrl = urlInput.value.trim();
    const nextNote = noteInput.value;
    const nextRawText = textInput.value;

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

        const moved = await window.BreadcrumbStorage.moveScrapToPosition(
          companyName,
          positionName,
          nextPosition,
          scrap.timestamp
        );

        if (!moved) {
          throw new Error("Unable to move scrap to the new position.");
        }
      }

      const updated = await window.BreadcrumbStorage.updateScrap(
        companyName,
        nextPosition,
        scrap.timestamp,
        {
          rawText: nextRawText,
          note: nextNote,
          url: nextUrl
        }
      );

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
    downloadMarkdown(fileName, markdown);
  });

  actions.append(copyButton, exportButton);
  header.append(heading, actions);

  const scrapList = document.createElement("div");
  scrapList.className = "scrap-list";
  (position.scraps || []).forEach((scrap) => {
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
  document.querySelectorAll(".btn-filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
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

async function loadCompanies() {
  state.companies = await window.BreadcrumbStorage.getAlphabeticalCompanies();
  state.velocity = await window.BreadcrumbStorage.getDailyApplicationVelocity(14);
  const scrapsInVault = state.companies.reduce((sum, company) => {
    return sum + (company.positions || []).reduce((positionSum, position) => positionSum + (position.scraps || []).length, 0);
  }, 0);
  const velocityTotal = state.velocity.reduce((sum, point) => sum + point.count, 0);
  if (scrapsInVault > 0 && velocityTotal === 0) {
    state.velocity = rebuildVelocityFromCompanies(14);
  }
  renderVelocityChart();
  computeFilteredItems();
  ensureSelectedItem();
  renderSidebar();
  renderMainView();
}

document.addEventListener("DOMContentLoaded", async () => {
  const searchInput = document.getElementById("global-search");

  searchInput.addEventListener("input", (event) => {
    applySearch(event.target.value || "");
  });

  document.querySelectorAll(".btn-filter").forEach((button) => {
    button.addEventListener("click", () => {
      applyFilterMode(button.dataset.mode);
    });
  });

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
