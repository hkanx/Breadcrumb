class BreadcrumbStorage {
  constructor(dbName = "BreadcrumbDB", version = 1) {
    this.dbName = dbName;
    this.version = version;
    this.storeName = "companies";
    this.schemaVersion = 2;
    this.dbPromise = null;
  }

  open() {
    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: "name" });
          store.createIndex("name", "name", { unique: true });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(`Failed to open IndexedDB: ${request.error?.message || "Unknown error"}`));
      request.onblocked = () => reject(new Error("IndexedDB open request was blocked."));
    });

    return this.dbPromise;
  }

  requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(`IndexedDB request failed: ${request.error?.message || "Unknown error"}`));
    });
  }

  isValidUrl(url) {
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

  toLocalDayKey(dateInput) {
    const date = new Date(dateInput);
    if (Number.isNaN(date.getTime())) {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    }

    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  normalizeTags(tags) {
    if (!Array.isArray(tags)) {
      return [];
    }

    const seen = new Set();
    return tags
      .map((item) => String(item || "").trim().toLowerCase())
      .filter((item) => item.length > 0)
      .filter((item) => {
        if (seen.has(item)) {
          return false;
        }
        seen.add(item);
        return true;
      });
  }

  normalizeScrap(scrap) {
    return {
      timestamp: scrap.timestamp || new Date().toISOString(),
      url: typeof scrap.url === "string" ? scrap.url : "",
      rawText: typeof scrap.rawText === "string" ? scrap.rawText : "",
      note: typeof scrap.note === "string" ? scrap.note : undefined,
      lastEditedAt: scrap.lastEditedAt || undefined,
      status: scrap.status || "saved",
      tags: this.normalizeTags(scrap.tags || []),
      favorite: Boolean(scrap.favorite),
      confidence: typeof scrap.confidence === "number" ? scrap.confidence : undefined,
      captureSource: scrap.captureSource || "manual",
      schemaVersion: this.schemaVersion,
      captureCount: Number.isInteger(scrap.captureCount) && scrap.captureCount > 0 ? scrap.captureCount : 1
    };
  }

  normalizeScrapInput(content) {
    if (typeof content === "string") {
      return {
        rawText: content.trim(),
        note: undefined,
        url: window.location.href,
        status: "saved",
        tags: [],
        favorite: false,
        confidence: undefined,
        captureSource: "manual"
      };
    }

    if (!content || typeof content !== "object") {
      throw new Error("Scrap content must be a string or an object.");
    }

    if (typeof content.rawText !== "string" || !content.rawText.trim()) {
      throw new Error("Scrap content requires a non-empty rawText string.");
    }

    const normalizedUrl = typeof content.url === "string" && content.url.trim() ? content.url.trim() : window.location.href;
    if (!this.isValidUrl(normalizedUrl)) {
      throw new Error("Invalid URL in scrap content.");
    }

    return {
      rawText: content.rawText.trim(),
      note: typeof content.note === "string" && content.note.trim() ? content.note.trim() : undefined,
      url: normalizedUrl,
      status: content.status || "saved",
      tags: this.normalizeTags(content.tags || []),
      favorite: Boolean(content.favorite),
      confidence: typeof content.confidence === "number" ? content.confidence : undefined,
      captureSource: content.captureSource || "manual"
    };
  }

  ensureCompanyRecord(companyRecord, companyName) {
    const record = companyRecord || { name: companyName, positions: [] };
    if (!Array.isArray(record.positions)) {
      record.positions = [];
    }
    return record;
  }

  ensurePosition(companyRecord, positionName) {
    let position = companyRecord.positions.find((item) => item.name === positionName);
    if (!position) {
      position = { name: positionName, scraps: [] };
      companyRecord.positions.push(position);
    }

    if (!Array.isArray(position.scraps)) {
      position.scraps = [];
    }

    return position;
  }

  normalizeUrlForDedup(url) {
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

  dedupKey({ url, timestamp, position }) {
    return `${this.normalizeUrlForDedup(url)}|${this.toLocalDayKey(timestamp)}|${String(position || "").trim().toLowerCase()}`;
  }

  removeEmptyPositions(companyRecord) {
    companyRecord.positions = (companyRecord.positions || []).filter(
      (position) => Array.isArray(position.scraps) && position.scraps.length > 0
    );
  }

  async saveScrap(company, position, content) {
    return this.saveScrapWithPolicy(company, position, content, { dedup: false });
  }

  async saveScrapWithPolicy(company, position, content, options = {}) {
    if (typeof company !== "string" || !company.trim()) {
      throw new Error("Company must be a non-empty string.");
    }
    if (typeof position !== "string" || !position.trim()) {
      throw new Error("Position must be a non-empty string.");
    }

    const companyName = company.trim();
    const positionName = position.trim();
    const normalizedContent = this.normalizeScrapInput(content);

    const scrap = this.normalizeScrap({
      timestamp: new Date().toISOString(),
      url: normalizedContent.url,
      rawText: normalizedContent.rawText,
      note: normalizedContent.note,
      status: normalizedContent.status,
      tags: normalizedContent.tags,
      favorite: normalizedContent.favorite,
      confidence: normalizedContent.confidence,
      captureSource: normalizedContent.captureSource,
      captureCount: 1
    });

    const db = await this.open();
    let outcome = "created";

    await new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, "readwrite");
      const store = transaction.objectStore(this.storeName);
      const getRequest = store.get(companyName);

      getRequest.onsuccess = () => {
        const companyRecord = this.ensureCompanyRecord(getRequest.result, companyName);
        const targetPosition = this.ensurePosition(companyRecord, positionName);

        if (options.dedup) {
          const targetKey = this.dedupKey({
            url: scrap.url,
            timestamp: scrap.timestamp,
            position: positionName
          });

          const existing = targetPosition.scraps.find((item) => {
            const normalized = this.normalizeScrap(item);
            const existingKey = this.dedupKey({
              url: normalized.url,
              timestamp: normalized.timestamp,
              position: positionName
            });
            return existingKey === targetKey;
          });

          if (existing) {
            const existingNorm = this.normalizeScrap(existing);
            existing.rawText = scrap.rawText;
            existing.url = scrap.url;
            existing.note = scrap.note || existingNorm.note;
            existing.status = existingNorm.status || "saved";
            existing.tags = this.normalizeTags([...(existingNorm.tags || []), ...(scrap.tags || [])]);
            existing.favorite = existingNorm.favorite;
            existing.confidence = scrap.confidence;
            existing.captureSource = scrap.captureSource;
            existing.captureCount = (existingNorm.captureCount || 1) + 1;
            existing.lastEditedAt = new Date().toISOString();
            outcome = "merged";
            store.put(companyRecord);
            return;
          }
        }

        targetPosition.scraps.push(scrap);
        store.put(companyRecord);
      };

      getRequest.onerror = () => reject(new Error(`Failed to load company record: ${getRequest.error?.message || "Unknown error"}`));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error(`IndexedDB transaction failed: ${transaction.error?.message || "Unknown error"}`));
      transaction.onabort = () => reject(new Error(`IndexedDB transaction aborted: ${transaction.error?.message || "Unknown error"}`));
    });

    return { scrap, outcome };
  }

  async updateScrap(companyName, positionName, scrapTimestamp, patch) {
    if (!companyName || !positionName || !scrapTimestamp) {
      throw new Error("Company, position, and scrap timestamp are required.");
    }

    if (patch.rawText !== undefined && (typeof patch.rawText !== "string" || !patch.rawText.trim())) {
      throw new Error("Edited rawText must be a non-empty string.");
    }

    if (patch.url !== undefined && patch.url && !this.isValidUrl(patch.url)) {
      throw new Error("Edited URL is invalid.");
    }

    const db = await this.open();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const getRequest = store.get(companyName.trim());

      let updated = false;

      getRequest.onsuccess = () => {
        const company = getRequest.result;
        if (!company) {
          return;
        }

        const position = (company.positions || []).find((item) => item.name === positionName.trim());
        if (!position) {
          return;
        }

        const scrap = (position.scraps || []).find((item) => item.timestamp === scrapTimestamp);
        if (!scrap) {
          return;
        }

        const normalized = this.normalizeScrap(scrap);
        scrap.rawText = patch.rawText !== undefined ? patch.rawText.trim() : normalized.rawText;
        scrap.note = patch.note !== undefined ? (typeof patch.note === "string" && patch.note.trim() ? patch.note.trim() : undefined) : normalized.note;
        scrap.url = patch.url !== undefined ? (patch.url ? patch.url.trim() : "") : normalized.url;
        scrap.status = patch.status !== undefined ? patch.status : normalized.status;
        scrap.favorite = patch.favorite !== undefined ? Boolean(patch.favorite) : normalized.favorite;
        scrap.tags = patch.tags !== undefined ? this.normalizeTags(patch.tags) : normalized.tags;
        scrap.lastEditedAt = new Date().toISOString();
        scrap.schemaVersion = this.schemaVersion;
        store.put(company);
        updated = true;
      };

      getRequest.onerror = () => reject(new Error(`Failed to load company record: ${getRequest.error?.message || "Unknown error"}`));
      tx.oncomplete = () => resolve(updated);
      tx.onerror = () => reject(new Error(`IndexedDB transaction failed: ${tx.error?.message || "Unknown error"}`));
      tx.onabort = () => reject(new Error(`IndexedDB transaction aborted: ${tx.error?.message || "Unknown error"}`));
    });
  }

  async setScrapStatus(companyName, positionName, scrapTimestamp, status) {
    return this.updateScrap(companyName, positionName, scrapTimestamp, { status });
  }

  async setScrapTags(companyName, positionName, scrapTimestamp, tags) {
    return this.updateScrap(companyName, positionName, scrapTimestamp, { tags });
  }

  async toggleScrapFavorite(companyName, positionName, scrapTimestamp, favorite) {
    return this.updateScrap(companyName, positionName, scrapTimestamp, { favorite });
  }

  async moveScrapToPosition(companyName, fromPositionName, toPositionName, scrapTimestamp, targetCompanyName) {
    if (!companyName || !fromPositionName || !toPositionName || !scrapTimestamp) {
      throw new Error("Company, source position, target position, and scrap timestamp are required.");
    }

    const sourceCompanyName = companyName.trim();
    const destinationCompanyName = (targetCompanyName || companyName).trim();
    const sourcePositionName = fromPositionName.trim();
    const destinationPositionName = toPositionName.trim();

    const db = await this.open();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const sourceRequest = store.get(sourceCompanyName);

      let moved = false;

      sourceRequest.onsuccess = () => {
        const sourceCompany = sourceRequest.result;
        if (!sourceCompany) {
          return;
        }

        const sourcePosition = (sourceCompany.positions || []).find((item) => item.name === sourcePositionName);
        if (!sourcePosition || !Array.isArray(sourcePosition.scraps)) {
          return;
        }

        const scrapIndex = sourcePosition.scraps.findIndex((item) => item.timestamp === scrapTimestamp);
        if (scrapIndex < 0) {
          return;
        }

        const [scrap] = sourcePosition.scraps.splice(scrapIndex, 1);

        const applyToDestination = (destinationCompany) => {
          if (!Array.isArray(destinationCompany.positions)) {
            destinationCompany.positions = [];
          }

          let destinationPosition = destinationCompany.positions.find((item) => item.name === destinationPositionName);
          if (!destinationPosition) {
            destinationPosition = { name: destinationPositionName, scraps: [] };
            destinationCompany.positions.push(destinationPosition);
          }

          if (!Array.isArray(destinationPosition.scraps)) {
            destinationPosition.scraps = [];
          }

          destinationPosition.scraps.push({ ...this.normalizeScrap(scrap), lastEditedAt: new Date().toISOString() });
        };

        if (destinationCompanyName === sourceCompanyName) {
          applyToDestination(sourceCompany);
          this.removeEmptyPositions(sourceCompany);
          store.put(sourceCompany);
          moved = true;
          return;
        }

        const destinationRequest = store.get(destinationCompanyName);
        destinationRequest.onsuccess = () => {
          const destinationCompany = destinationRequest.result || {
            name: destinationCompanyName,
            positions: []
          };

          applyToDestination(destinationCompany);
          this.removeEmptyPositions(sourceCompany);
          store.put(sourceCompany);
          store.put(destinationCompany);
          moved = true;
        };

        destinationRequest.onerror = () => reject(new Error(`Failed to load destination company: ${destinationRequest.error?.message || "Unknown error"}`));
      };

      sourceRequest.onerror = () => reject(new Error(`Failed to load source company: ${sourceRequest.error?.message || "Unknown error"}`));
      tx.oncomplete = () => resolve(moved);
      tx.onerror = () => reject(new Error(`IndexedDB transaction failed: ${tx.error?.message || "Unknown error"}`));
      tx.onabort = () => reject(new Error(`IndexedDB transaction aborted: ${tx.error?.message || "Unknown error"}`));
    });
  }

  async deleteScrap(companyName, positionName, scrapTimestamp) {
    if (!companyName || !positionName || !scrapTimestamp) {
      throw new Error("Company, position, and scrap timestamp are required.");
    }

    const db = await this.open();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const getRequest = store.get(companyName.trim());

      let deleted = false;

      getRequest.onsuccess = () => {
        const company = getRequest.result;
        if (!company) {
          return;
        }

        const position = (company.positions || []).find((item) => item.name === positionName.trim());
        if (!position || !Array.isArray(position.scraps)) {
          return;
        }

        const index = position.scraps.findIndex((item) => item.timestamp === scrapTimestamp);
        if (index < 0) {
          return;
        }

        position.scraps.splice(index, 1);
        this.removeEmptyPositions(company);
        store.put(company);
        deleted = true;
      };

      getRequest.onerror = () => reject(new Error(`Failed to load company record: ${getRequest.error?.message || "Unknown error"}`));
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(new Error(`IndexedDB transaction failed: ${tx.error?.message || "Unknown error"}`));
      tx.onabort = () => reject(new Error(`IndexedDB transaction aborted: ${tx.error?.message || "Unknown error"}`));
    });
  }

  async getAlphabeticalCompanies() {
    const db = await this.open();
    const transaction = db.transaction(this.storeName, "readonly");
    const store = transaction.objectStore(this.storeName);
    const companies = await this.requestToPromise(store.getAll());

    return (Array.isArray(companies) ? companies : [])
      .map((company) => ({
        ...company,
        positions: (company.positions || []).map((position) => ({
          ...position,
          scraps: (position.scraps || []).map((scrap) => this.normalizeScrap(scrap))
        }))
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  async getDailyApplicationVelocity(days = 14) {
    const windowDays = Number.isInteger(days) && days > 0 ? days : 14;
    const companies = await this.getAlphabeticalCompanies();
    const countsByDay = new Map();

    companies.forEach((company) => {
      (company.positions || []).forEach((position) => {
        (position.scraps || []).forEach((scrap) => {
          const dayKey = this.toLocalDayKey(scrap.timestamp);
          countsByDay.set(dayKey, (countsByDay.get(dayKey) || 0) + 1);
        });
      });
    });

    const result = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
      const day = new Date(now);
      day.setDate(now.getDate() - offset);
      const dayKey = this.toLocalDayKey(day);
      result.push({ date: dayKey, count: countsByDay.get(dayKey) || 0 });
    }

    return result;
  }

  async exportVaultJson() {
    const companies = await this.getAlphabeticalCompanies();
    return {
      schemaVersion: this.schemaVersion,
      exportedAt: new Date().toISOString(),
      companies
    };
  }

  async importVaultJson(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.companies)) {
      throw new Error("Invalid import payload.");
    }

    const db = await this.open();

    await new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);

      payload.companies.forEach((company) => {
        if (!company?.name) {
          return;
        }

        const normalizedCompany = {
          name: String(company.name),
          positions: (company.positions || []).map((position) => ({
            name: String(position.name || "Untitled Position"),
            scraps: (position.scraps || []).map((scrap) => this.normalizeScrap(scrap))
          }))
        };

        store.put(normalizedCompany);
      });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(`Import transaction failed: ${tx.error?.message || "Unknown error"}`));
      tx.onabort = () => reject(new Error(`Import transaction aborted: ${tx.error?.message || "Unknown error"}`));
    });

    return true;
  }

  async deleteCompany(name) {
    if (typeof name !== "string" || !name.trim()) {
      throw new Error("Company name must be a non-empty string.");
    }

    const companyName = name.trim();
    const db = await this.open();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, "readwrite");
      const store = transaction.objectStore(this.storeName);
      const getRequest = store.get(companyName);

      let existed = false;

      getRequest.onsuccess = () => {
        existed = Boolean(getRequest.result);
        if (existed) {
          store.delete(companyName);
        }
      };

      getRequest.onerror = () => reject(new Error(`Failed to check company before delete: ${getRequest.error?.message || "Unknown error"}`));
      transaction.oncomplete = () => resolve(existed);
      transaction.onerror = () => reject(new Error(`IndexedDB transaction failed: ${transaction.error?.message || "Unknown error"}`));
      transaction.onabort = () => reject(new Error(`IndexedDB transaction aborted: ${transaction.error?.message || "Unknown error"}`));
    });
  }
}

window.BreadcrumbStorage = new BreadcrumbStorage();
