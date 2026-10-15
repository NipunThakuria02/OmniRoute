import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { apiFetch, getBaseUrl, isRouteUnavailableStatus } from "../api.mjs";
import { emit } from "../output.mjs";
import { t } from "../i18n.mjs";

function fmtTs(v) {
  if (!v) return "-";
  return new Date(typeof v === "number" ? v * 1000 : v).toLocaleString();
}

async function confirm(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${q} [y/N] `, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase() === "y");
    });
  });
}

function authHeaders(opts) {
  const h = { accept: "application/json" };
  if (opts.apiKey) h["Authorization"] = `Bearer ${opts.apiKey}`;
  return h;
}

const BUNDLE_PARTS = ["settings", "combos", "keys", "providers", "policies", "skills", "memory"];

const syncTokenSchema = [
  { key: "id", header: "Token ID", width: 16 },
  { key: "name", header: "Name", width: 24 },
  { key: "scope", header: "Scope", width: 22 },
  { key: "createdAt", header: "Created", formatter: fmtTs },
  { key: "expiresAt", header: "Expires", formatter: fmtTs },
  { key: "lastUsed", header: "Last Used", formatter: fmtTs },
];

const EXPORT_ALL_PATH = "/api/db-backups/exportAll";
// Building the archive (SQLite backup + tar of the call-log artifacts) can outlast the
// default 30 s request timeout on a large instance.
const EXPORT_ALL_TIMEOUT_MS = 300_000;
const SAFE_ARCHIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Server-suggested filename (Content-Disposition), reduced to a safe bare file name. */
export function archiveFileName(contentDisposition, now = new Date()) {
  const match = /filename="?([^";]+)"?/i.exec(contentDisposition || "");
  const suggested = match ? basename(match[1].trim()) : "";
  if (SAFE_ARCHIVE_NAME.test(suggested)) return suggested;
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `omniroute-full-backup-${stamp}.tar.gz`;
}

function pullFailureHint(status) {
  if (status === 401 || status === 403) {
    return (
      "the full backup requires an operator credential: run this on the server host " +
      "(local CLI credential) or sign in to the dashboard; API keys and remote access " +
      "tokens are refused."
    );
  }
  if (isRouteUnavailableStatus(status)) {
    return `the server does not serve GET ${EXPORT_ALL_PATH}; update OmniRoute on the server.`;
  }
  return null;
}

async function reportPullFailure(res) {
  let message = `HTTP ${res.status}`;
  try {
    await res.assertOk();
  } catch (err) {
    if (err?.message) message = err.message;
  }
  const hint = pullFailureHint(res.status);
  process.stderr.write(
    `Error: sync pull failed (HTTP ${res.status}): ${message}${hint ? `\n  ${hint}` : ""}\n`
  );
  return res.exitCode || 1;
}

function writeArchive(target, buf) {
  try {
    // `wx`: never clobber an existing file; 0o600: the archive holds the stored credentials.
    writeFileSync(target, buf, { flag: "wx", mode: 0o600 });
    return 0;
  } catch (err) {
    const reason = err?.code === "EEXIST" ? "file already exists" : err?.code || err?.message;
    process.stderr.write(`Error: cannot write ${target}: ${reason}\n`);
    return 1;
  }
}

/**
 * `omniroute sync pull [outPath]` — download the server's full backup archive (`.tar.gz`)
 * from `GET /api/db-backups/exportAll`. The route is operator-only, so against a loopback
 * server `apiFetch` attaches the machine-bound local CLI credential.
 */
export async function runSyncPull(outPath, globalOpts = {}) {
  let res;
  try {
    res = await apiFetch(EXPORT_ALL_PATH, {
      apiKey: globalOpts.apiKey,
      baseUrl: globalOpts.baseUrl,
      context: globalOpts.context,
      headers: { accept: "application/gzip, application/json" },
      timeout: EXPORT_ALL_TIMEOUT_MS,
    });
  } catch (err) {
    process.stderr.write(`Error: sync pull failed: ${err?.message || "network error"}\n`);
    return err?.exitCode || 1;
  }
  if (!res.ok) return reportPullFailure(res);

  const target = outPath || archiveFileName(res.headers.get("content-disposition"));
  const buf = Buffer.from(await res.arrayBuffer());
  const exitCode = writeArchive(target, buf);
  if (exitCode === 0) process.stdout.write(`Saved ${buf.length} bytes to ${target}\n`);
  return exitCode;
}

export function registerSync(program) {
  const sync = program.command("sync").description(t("sync.description"));

  sync
    .command("push")
    .description(t("sync.push.description"))
    .option("--target <t>", t("sync.push.target"), "cloud")
    .option("--bundle <list>", t("sync.push.bundle"), (v) => v.split(","), BUNDLE_PARTS)
    .option("--dry-run", t("sync.push.dryRun"))
    .action(async (opts, cmd) => {
      const res = await apiFetch("/api/sync/cloud", {
        method: "POST",
        body: { parts: opts.bundle, dryRun: !!opts.dryRun, target: opts.target },
      });
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), cmd.optsWithGlobals());
    });

  sync
    .command("pull [outPath]")
    .description(t("sync.pull.description"))
    .action(async (outPath, opts, cmd) => {
      const exitCode = await runSyncPull(outPath, cmd.optsWithGlobals());
      if (exitCode !== 0) process.exit(exitCode);
    });

  sync
    .command("diff")
    .option("--source <s>", t("sync.diff.source"))
    .option("--target <t>", t("sync.diff.target"))
    .action(async (opts, cmd) => {
      const src = opts.source ?? "local";
      const tgt = opts.target ?? "cloud";
      const res = await apiFetch(`/api/sync/cloud?op=diff&source=${src}&target=${tgt}`);
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), cmd.optsWithGlobals());
    });

  sync
    .command("bundle <outPath>")
    .description(t("sync.bundle.description"))
    .option("--include <list>", t("sync.bundle.include"), (v) => v.split(","), BUNDLE_PARTS)
    .action(async (outPath, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const res = await fetch(
        `${getBaseUrl(globalOpts)}/api/sync/bundle?parts=${opts.include.join(",")}`,
        { headers: authHeaders(globalOpts) }
      );
      if (!res.ok) {
        process.stderr.write(`HTTP ${res.status}\n`);
        process.exit(1);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(outPath, buf);
      process.stdout.write(`Saved ${buf.length} bytes to ${outPath}\n`);
    });

  sync
    .command("import <bundlePath>")
    .description(t("sync.import.description"))
    .option("--dry-run", t("sync.import.dryRun"))
    .action(async (bundlePath, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const body = readFileSync(bundlePath);
      const res = await fetch(
        `${getBaseUrl(globalOpts)}/api/db-backups/import?dryRun=${opts.dryRun ? "true" : "false"}`,
        {
          method: "POST",
          headers: {
            ...authHeaders(globalOpts),
            "Content-Type": "application/octet-stream",
          },
          body,
        }
      );
      if (!res.ok) {
        process.stderr.write(`HTTP ${res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), globalOpts);
    });

  sync
    .command("initialize")
    .option("--from-cloud", t("sync.initialize.fromCloud"))
    .action(async (opts, cmd) => {
      const res = await apiFetch("/api/sync/initialize", {
        method: "POST",
        body: { fromCloud: !!opts.fromCloud },
      });
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), cmd.optsWithGlobals());
    });

  const tokens = sync.command("tokens").description(t("sync.tokens.description"));

  tokens.command("list").action(async (opts, cmd) => {
    const res = await apiFetch("/api/sync/tokens");
    if (!res.ok) {
      process.stderr.write(`Error: ${res.status}\n`);
      process.exit(1);
    }
    emit(await res.json(), cmd.optsWithGlobals(), syncTokenSchema);
  });

  tokens
    .command("create")
    .option("--name <n>", t("sync.tokens.create.name"))
    .option("--scope <s>", t("sync.tokens.create.scope"))
    .option("--ttl <duration>", t("sync.tokens.create.ttl"), "30d")
    .action(async (opts, cmd) => {
      const body = { name: opts.name, scope: opts.scope, ttl: opts.ttl };
      const res = await apiFetch("/api/sync/tokens", { method: "POST", body });
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), cmd.optsWithGlobals());
    });

  tokens
    .command("revoke <id>")
    .option("--yes", t("sync.tokens.revoke.yes"))
    .action(async (id, opts, cmd) => {
      if (!opts.yes) {
        const ok = await confirm(`Revoke ${id}?`);
        if (!ok) return;
      }
      const res = await apiFetch(`/api/sync/tokens/${id}`, { method: "DELETE" });
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      process.stdout.write("Revoked\n");
    });

  sync.command("status").action(async (opts, cmd) => {
    const res = await apiFetch("/api/sync/cloud?op=status");
    if (!res.ok) {
      process.stderr.write(`Error: ${res.status}\n`);
      process.exit(1);
    }
    emit(await res.json(), cmd.optsWithGlobals());
  });

  sync
    .command("resolve")
    .description(t("sync.resolve.description"))
    .action(async (opts, cmd) => {
      const res = await apiFetch("/api/sync/cloud?op=conflicts");
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      const conflicts = await res.json();
      for (const c of conflicts.items ?? []) {
        const choice = await confirm(`Conflict on ${c.path} — keep local?`);
        await apiFetch("/api/sync/cloud", {
          method: "POST",
          body: { op: "resolve", path: c.path, choice: choice ? "local" : "remote" },
        });
      }
    });
}
