class BreadcrumbStorage {
  constructor(dbName = "BreadcrumbDB", version = 1) {
    this.dbName = dbName;
    this.version = version;
    this.storeName = "companies";
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

  normalizeScrapInput(content) {
    if (typeof content === "string") {
      return { rawText: content.trim(), note: undefined, url: window.location.href };
    }

    if (!content || typeof content !== "object") {
      throw new Error("Scrap content must be a string or an object.");
    }

    if (typeof content.rawText !== "string" || !content.rawText.trim()) {
      throw new Error("Scrap content requires a non-empty rawText string.");
    }

    return {
      rawText: content.rawText.trim(),
      note: typeof content.note === "string" && content.note.trim() ? content.note.trim() : undefined,
      url: typeof content.url === "string" && content.url.trim() ? content.url.trim() : window.location.href
    };
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

  removeEmptyPositions(companyRecord) {
    companyRecord.positions = (companyRecord.positions || []).filter(
      (position) => Array.isArray(position.scraps) && position.scraps.length > 0
    );
  }

  async saveScrap(company, position, content) {
    if (typeof company !== "string" || !company.trim()) {
      throw new Error("Company must be a non-empty string.");
    }
    if (typeof position !== "string" || !position.trim()) {
      throw new Error("Position must be a non-empty string.");
    }

    const companyName = company.trim();
    const positionName = position.trim();
    const normalizedContent = this.normalizeScrapInput(content);

    const scrap = {
      timestamp: new Date().toISOString(),
      url: normalizedContent.url,
      rawText: normalizedContent.rawText,
      ...(normalizedContent.note ? { note: normalizedContent.note } : {})
    };

    const db = await this.open();

    await new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, "readwrite");
      const store = transaction.objectStore(this.storeName);
      const getRequest = store.get(companyName);

      getRequest.onsuccess = () => {
        const companyRecord = getRequest.result || { name: companyName, positions: [] };

        if (!Array.isArray(companyRecord.positions)) {
          companyRecord.positions = [];
        }

        let targetPosition = companyRecord.positions.find((item) => item.name === positionName);
        if (!targetPosition) {
          targetPosition = { name: positionName, scraps: [] };
          companyRecord.positions.push(targetPosition);
        }

        if (!Array.isArray(targetPosition.scraps)) {
          targetPosition.scraps = [];
        }

        targetPosition.scraps.push(scrap);
        store.put(companyRecord);
      };

      getRequest.onerror = () => reject(new Error(`Failed to load company record: ${getRequest.error?.message || "Unknown error"}`));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error(`IndexedDB transaction failed: ${transaction.error?.message || "Unknown error"}`));
      transaction.onabort = () => reject(new Error(`IndexedDB transaction aborted: ${transaction.error?.message || "Unknown error"}`));
    });

    return scrap;
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

        if (patch.rawText !== undefined) {
          scrap.rawText = patch.rawText.trim();
        }

        if (patch.note !== undefined) {
          scrap.note = typeof patch.note === "string" && patch.note.trim() ? patch.note.trim() : undefined;
        }

        if (patch.url !== undefined) {
          scrap.url = patch.url ? patch.url.trim() : "";
        }

        scrap.lastEditedAt = new Date().toISOString();
        store.put(company);
        updated = true;
      };

      getRequest.onerror = () => reject(new Error(`Failed to load company record: ${getRequest.error?.message || "Unknown error"}`));
      tx.oncomplete = () => resolve(updated);
      tx.onerror = () => reject(new Error(`IndexedDB transaction failed: ${tx.error?.message || "Unknown error"}`));
      tx.onabort = () => reject(new Error(`IndexedDB transaction aborted: ${tx.error?.message || "Unknown error"}`));
    });
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

          destinationPosition.scraps.push({ ...scrap, lastEditedAt: new Date().toISOString() });
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

        destinationRequest.onerror = () => {
          reject(new Error(`Failed to load destination company: ${destinationRequest.error?.message || "Unknown error"}`));
        };
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

    return (Array.isArray(companies) ? companies : []).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  }

  async getDailyApplicationVelocity(days = 14) {
    const windowDays = Number.isInteger(days) && days > 0 ? days : 14;
    const companies = await this.getAlphabeticalCompanies();
    const countsByDay = new Map();
    const toLocalDayKey = (date) => {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    };

    companies.forEach((company) => {
      (company.positions || []).forEach((position) => {
        (position.scraps || []).forEach((scrap) => {
          if (!scrap?.timestamp) {
            return;
          }

          const date = new Date(scrap.timestamp);
          if (Number.isNaN(date.getTime())) {
            // Keep legacy or malformed entries visible in analytics by counting them today.
            const todayKey = toLocalDayKey(new Date());
            countsByDay.set(todayKey, (countsByDay.get(todayKey) || 0) + 1);
            return;
          }

          const dayKey = toLocalDayKey(date);
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
      const dayKey = toLocalDayKey(day);
      result.push({ date: dayKey, count: countsByDay.get(dayKey) || 0 });
    }

    return result;
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
