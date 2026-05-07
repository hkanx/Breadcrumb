# Breadcrumb 🍞

Breadcrumb is a Chrome extension for capturing, organizing, and revisiting web content from any page.

It replaces manual copy/paste workflows with a structured, local-first vault that supports quick capture, filtering, editing, and export.

## What It Is

Breadcrumb is a general-purpose web capture extension that helps you save content from pages, organize it in a structured vault, and retrieve it later with search and filters.

It is intentionally domain-agnostic: the same workflow can support research, learning notes, reference collection, market tracking, or any repeated “capture and revisit” web workflow.

## Why Breadcrumb

Breadcrumb was built to solve a common workflow gap:

- Browsers are great at navigation, but not great at structured capture.
- Notes apps are great at long-form writing, but high-friction for quick page extraction.

Breadcrumb bridges those two modes by making capture lightweight and retrieval structured.

## Impact 

- Reduced friction from "save now, organize later" workflows.
- Added confidence-aware capture to reduce low-quality saves.
- Designed a structured metadata model that scales beyond simple bookmarking.
- Kept architecture local-first and backend-free for privacy and portability.

## Core Features

- Capture from current page via popup or keyboard shortcut.
- Confidence-based shortcut flow (auto-save vs review fallback).
- Structured vault with search, filters, and inline editing.
- Metadata controls: status, tags, favorites.
- Bulk actions for visible/filtered records.
- Export to Markdown and full JSON backup/import.
- Export backup bundles for private GitHub archival workflows.
- Direct private GitHub backup from Vault (token or GitHub OAuth device flow).
- Side Panel support for in-context review.

## Technical Decisions and System Design

### 1) Manifest V3 + Event-Driven Background

**Decision:** Use a service worker (`background.js`) as the orchestration layer.  
**Why:** MV3 encourages short-lived, event-driven background execution.  
**Result:** Cleaner lifecycle handling and a clear boundary between capture orchestration and UI.

### 2) Separation of Concerns by Runtime Role

- `content.js`: page extraction and confidence scoring
- `background.js`: command handling, shortcut flow, auto-save policy
- `storage.js`: IndexedDB data model and mutation APIs
- `popup.*`: capture/review surface
- `options.*`: vault management UI

**Decision:** Keep logic modular rather than coupling UI and persistence.  
**Result:** Easier debugging, safer iteration, and clearer extension of features.

### 3) Local-First Persistence (IndexedDB)

**Decision:** Store data in IndexedDB, no backend required.  
**Why:** Privacy, offline support, zero infrastructure overhead.  
**Tradeoff:** No built-in cross-device sync.  
**Mitigation:** JSON export/import and Markdown export.

### 4) Structured Data Model for Queryability

Hierarchy:

- Company -> Position -> Scraps[]

Scrap metadata includes:

- `timestamp`, `url`, `rawText`, `note`
- `status`, `tags`, `favorite`
- `confidence`, `captureSource`, `schemaVersion`, `captureCount`, `backupId`

**Decision:** Explicit metadata instead of free-form blobs.  
**Result:** Enables filtering, bulk operations, diagnostics, and safe schema evolution.

### 5) Reliability Strategy: Confidence + Fallback

**Decision:** Compute scrape confidence and route behavior accordingly.  
**Behavior:**

- High confidence -> one-key auto-save.
- Low confidence -> popup review before saving.

**Result:** Maintains capture speed while reducing silent low-quality data.

### 6) Deduplication Policy

**Decision:** Deduplicate by `normalizedUrl + localDay + position`.  
**Why:** Prevent repeated saves from bloating storage while preserving daily activity signal.

### 7) Side Panel + Event-Driven Refresh

**Decision:** Support both options page and side panel view.  
**Why:** Review saved data without leaving browsing context.  
**Implementation:** Runtime message refresh + focus/visibility fallback.

### 8) Portability and Backward Compatibility

**Decision:** Add schema-aware JSON import/export.  
**Why:** Long-term maintainability and user-controlled migration/backup.

### 9) Private Backup Without Cloud Coupling

**Decision:** Add `exportBackupBundle({ profile })` for deterministic, repo-friendly export payloads.  
**Why:** Keep production data local while enabling auditable private GitHub backups.  
**Implementation:** Companion script materializes bundle files in a private repo and commits/pushes via local git auth, using persistent `backupId` upserts to edit-in-place without duplicate records.

### 10) Direct GitHub Backup in Extension

**Decision:** Support direct `Backup to GitHub Now` from Vault (without manual bundle apply).  
**Why:** Reduce backup friction and avoid requiring separate terminal steps for routine syncs.  
**Implementation:** Background service worker writes to GitHub Contents API and records `created/updated/unchanged/deleted` summary, plus latest commit SHA for verification.

### 11) OAuth Reliability in MV3 Service Worker Lifecycle

**Decision:** Persist GitHub OAuth device-flow state in `chrome.storage.local`.  
**Why:** MV3 service workers can sleep/reset mid-flow; in-memory-only auth state is unreliable.  
**Implementation:** Store active device flow + recovered poll state so OAuth completion survives worker restarts.

## End-to-End Flow

1. User triggers capture (shortcut/icon/popup).
2. Background requests extraction from content script.
3. Content script returns text + confidence.
4. Background applies capture policy (auto-save or review fallback).
5. Storage applies normalization + dedup + metadata writes.
6. Vault updates via storage reads and runtime change events.

## Engineering Tradeoffs

- **Privacy vs Sync:** prioritized local-only privacy over cloud sync complexity.
- **Speed vs Accuracy:** confidence-gated auto-save balances throughput with data quality.
- **Simplicity vs Extensibility:** plain JS stack with modular boundaries for future growth.

## Privacy and Data

Breadcrumb is local-first:

- Data is stored in browser IndexedDB.
- No required backend service.
- No required cloud sync.
- Backup/restore via JSON export/import.
- Optional private-repo backups via export bundle + local script.
- Optional direct private-repo backup from Vault via GitHub token + repo settings.
- Optional GitHub OAuth device flow for direct backup auth.

## Install (Unpacked)

1. Clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this project folder.

## Keyboard Shortcut

Suggested command:

- macOS: `Command+Shift+S`
- Windows/Linux: `Ctrl+Shift+S`

If needed, rebind at `chrome://extensions/shortcuts`.

## Development Notes

Key files:

- `manifest.json`
- `background.js`
- `content.js`
- `storage.js`
- `popup.*`
- `options.*`

Backup docs:

- `docs/private-github-backup.md`
- `scripts/backup_to_github.mjs`
