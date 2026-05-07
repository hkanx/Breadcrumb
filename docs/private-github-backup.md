# Private GitHub Backup (Breadcrumb)

This backup flow keeps Breadcrumb local-first while giving you a private GitHub backup history.

## Direct backup from extension

You can run backup directly in Vault:

1. Open `Bulk + Export Actions` -> `Private GitHub Backup`.
2. Enter:
   - GitHub token (with private repo write access),
   - owner,
   - repo,
   - branch (optional, defaults to `main`).
3. Click `Save Connection`.
4. Click `Backup to GitHub Now`.

Breadcrumb will upsert by `backupId` (edit-in-place, no duplicate records, no auto-delete).

OAuth option:

1. Enter your GitHub OAuth App Client ID.
2. Click `Connect GitHub OAuth`.
3. Complete device login on GitHub with the shown code.
4. Vault receives the token and you can continue with `Backup to GitHub Now`.

## 1) Export a backup bundle from Breadcrumb

1. Open Breadcrumb Vault (`options.html` / side panel).
2. Open `Bulk + Export Actions`.
3. Click `Export Backup Bundle`.
4. Choose:
   - `Cancel` -> sanitized backup (default)
   - `OK` -> full raw capture backup
5. A `.json` backup bundle is downloaded.

## 2) Apply bundle to your private repo

Run:

```bash
node scripts/backup_to_github.mjs \
  --bundle "/path/to/breadcrumb-backup-bundle-....json" \
  --repo "/path/to/your-private-breadcrumb-backup-repo" \
  --push
```

Without `--push`, the script creates a local commit only.

## 3) Repo structure written by backup

- `data/vault.json`
- `by-company/<company>/<position>/<timestamp-id>.md`
- `by-date/YYYY/MM/DD/<company>__<position>__<id>.md`
- `indexes/companies.json`
- `indexes/positions.json`
- `indexes/dates.json`
- `indexes/backup-id-map.json`
- `meta/backup-manifest.json`

## Privacy notes

- Extension still stores live data in IndexedDB.
- Backups are generated on demand.
- GitHub token is stored in extension local storage when using direct backup.
- Backed-up records are updated in place by `backupId` (no auto-delete behavior).
