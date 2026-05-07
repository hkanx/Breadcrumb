#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/backup_to_github.mjs --bundle /path/to/breadcrumb-backup-bundle.json --repo /path/to/private-repo [--push]",
      "",
      "Notes:",
      "  - --push is optional. Without it, script commits locally only.",
      "  - Repo must already be a git repository.",
      "  - Backup applies edit-only upserts by backupId (no automatic deletes)."
    ].join("\n")
  );
}

function parseArgs(argv) {
  const args = { push: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--bundle") {
      args.bundle = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--repo") {
      args.repo = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--push") {
      args.push = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      args.help = true;
    }
  }
  return args;
}

async function ensureGitRepo(repoPath) {
  const gitDir = path.join(repoPath, ".git");
  await fs.access(gitDir);
}

async function git(repoPath, ...args) {
  return execFileAsync("git", args, { cwd: repoPath });
}

async function hasChanges(repoPath) {
  const { stdout } = await git(repoPath, "status", "--porcelain");
  return stdout.trim().length > 0;
}

async function readJsonIfExists(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (_error) {
    return null;
  }
}

async function writeTextFile(repoPath, relativePath, content) {
  const fullPath = path.join(repoPath, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

function groupByCompany(records) {
  const map = new Map();
  records.forEach((record) => {
    const company = String(record.company || "Unknown Company");
    const position = String(record.position || "Untitled Position");
    const backupId = String(record.scrapId || record.backupId || "");
    const entry = {
      id: backupId,
      timestamp: record.timestamp || "",
      path: record.byCompanyPath || ""
    };
    if (!map.has(company)) {
      map.set(company, new Map());
    }
    const positionMap = map.get(company);
    if (!positionMap.has(position)) {
      positionMap.set(position, []);
    }
    positionMap.get(position).push(entry);
  });

  return Array.from(map.entries()).map(([company, positionsMap]) => ({
    name: company,
    positions: Array.from(positionsMap.entries()).map(([position, entries]) => ({
      name: position,
      count: entries.length,
      entries
    }))
  }));
}

function groupByPosition(records) {
  const map = new Map();
  records.forEach((record) => {
    const key = `${record.company || "Unknown Company"}::${record.position || "Untitled Position"}`;
    if (!map.has(key)) {
      map.set(key, {
        company: record.company || "Unknown Company",
        position: record.position || "Untitled Position",
        entries: []
      });
    }
    map.get(key).entries.push({
      id: record.scrapId || record.backupId || "",
      date: record.dayKey || "",
      path: record.byCompanyPath || ""
    });
  });
  return Array.from(map.values());
}

function groupByDate(records) {
  const map = new Map();
  records.forEach((record) => {
    const day = record.dayKey || "unknown-day";
    if (!map.has(day)) {
      map.set(day, []);
    }
    map.get(day).push({
      company: record.company || "Unknown Company",
      position: record.position || "Untitled Position",
      id: record.scrapId || record.backupId || "",
      path: record.byDatePath || ""
    });
  });
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, entries]) => ({ date, entries }));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.bundle || !args.repo) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const bundlePath = path.resolve(args.bundle);
  const repoPath = path.resolve(args.repo);
  const bundleRaw = await fs.readFile(bundlePath, "utf8");
  const bundle = JSON.parse(bundleRaw);

  if (!Array.isArray(bundle.files)) {
    throw new Error("Invalid bundle: expected 'files' array.");
  }

  await ensureGitRepo(repoPath);

  const existingMapPayload = await readJsonIfExists(path.join(repoPath, "indexes/backup-id-map.json"), { map: {} });
  const existingMap = existingMapPayload?.map && typeof existingMapPayload.map === "object" ? existingMapPayload.map : {};

  const fileMap = new Map();
  bundle.files.forEach((file) => {
    if (file?.path && typeof file.content === "string") {
      fileMap.set(file.path, file.content);
    }
  });

  let incomingMap = {};
  if (bundle.backupIdMap && typeof bundle.backupIdMap === "object") {
    incomingMap = bundle.backupIdMap;
  } else {
    const bundleMapFile = fileMap.get("indexes/backup-id-map.json");
    if (bundleMapFile) {
      const parsed = JSON.parse(bundleMapFile);
      incomingMap = parsed?.map && typeof parsed.map === "object" ? parsed.map : {};
    }
  }

  const summary = { created: 0, updated: 0, unchanged: 0, deleted: 0 };
  const nextMap = {};
  const resolvedRecords = [];

  for (const [backupId, incomingEntry] of Object.entries(incomingMap)) {
    const current = existingMap[backupId];
    const incomingCompanyPath = incomingEntry.byCompanyPath;
    const incomingDatePath = incomingEntry.byDatePath;
    const markdownContent = fileMap.get(incomingCompanyPath);

    if (typeof markdownContent !== "string") {
      continue;
    }

    const targetCompanyPath = current?.byCompanyPath || incomingCompanyPath;
    const targetDatePath = current?.byDatePath || incomingDatePath;
    const existingCompanyText = await readTextIfExists(path.join(repoPath, targetCompanyPath));

    if (!current) {
      summary.created += 1;
    } else if (existingCompanyText === markdownContent) {
      summary.unchanged += 1;
    } else {
      summary.updated += 1;
    }

    await writeTextFile(repoPath, targetCompanyPath, markdownContent);
    await writeTextFile(repoPath, targetDatePath, markdownContent);

    const dateKey = String(incomingEntry.timestamp || "").slice(0, 10);
    const resolved = {
      backupId,
      scrapId: backupId,
      company: incomingEntry.company,
      position: incomingEntry.position,
      timestamp: incomingEntry.timestamp,
      dayKey: /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : "",
      byCompanyPath: targetCompanyPath,
      byDatePath: targetDatePath
    };
    resolvedRecords.push(resolved);

    nextMap[backupId] = {
      ...incomingEntry,
      byCompanyPath: targetCompanyPath,
      byDatePath: targetDatePath
    };
  }

  const generatedAt = new Date().toISOString();
  const companiesIndex = { generatedAt, companies: groupByCompany(resolvedRecords) };
  const positionsIndex = { generatedAt, positions: groupByPosition(resolvedRecords) };
  const datesIndex = { generatedAt, dates: groupByDate(resolvedRecords) };
  const backupMapIndex = { generatedAt, map: nextMap };

  await writeTextFile(repoPath, "indexes/companies.json", JSON.stringify(companiesIndex, null, 2));
  await writeTextFile(repoPath, "indexes/positions.json", JSON.stringify(positionsIndex, null, 2));
  await writeTextFile(repoPath, "indexes/dates.json", JSON.stringify(datesIndex, null, 2));
  await writeTextFile(repoPath, "indexes/backup-id-map.json", JSON.stringify(backupMapIndex, null, 2));

  // Pass-through non-scrap files from bundle.
  for (const [filePath, content] of fileMap.entries()) {
    if (filePath.startsWith("by-company/") || filePath.startsWith("by-date/") || filePath.startsWith("indexes/")) {
      continue;
    }
    await writeTextFile(repoPath, filePath, content);
  }

  await git(repoPath, "add", ".");

  if (!(await hasChanges(repoPath))) {
    console.log("No changes to commit.");
    console.log(JSON.stringify(summary));
    return;
  }

  const profile = bundle.profile || "sanitized";
  const timestamp = new Date().toISOString();
  const message = `[Backup] ${timestamp} (${profile})`;
  await git(repoPath, "commit", "-m", message);
  console.log(`Committed backup: ${message}`);
  console.log(`Backup summary: ${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.deleted} deleted`);

  if (args.push) {
    await git(repoPath, "push");
    console.log("Pushed backup to remote.");
  } else {
    console.log("Commit created locally. Re-run with --push to publish.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
