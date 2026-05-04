import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { access, copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import {
  addShareRecord,
  emptySessionJsonl,
  filterRecords,
  getSessionTitle,
  readRegistry,
  remoteObjectsToShareRecords,
  removeShareRecords,
  sanitizeHtmlSession,
  sanitizeJsonl,
  stripAbsolutePathPrefix,
  type Format,
  type RemoteObject,
  type ShareRecord,
} from "./core";
import { type RedactionConfig, scanForSecrets } from "./redaction";

type Mode = "auto" | "wrangler" | "s3";
type RunResult = { code: number | null; stdout: string; stderr: string };

type ShareOptions = {
  format?: Format;
  mode?: Mode;
  unsafe?: boolean;
};

type BrowserAction =
  | { type: "close" }
  | { type: "delete"; record: ShareRecord }
  | { type: "delete-visible"; records: ShareRecord[] };

function parseArgs(args: string): ShareOptions {
  const out: ShareOptions = {};
  const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/^"|"$/g, "")) ?? [];
  for (const raw of tokens) {
    if (raw === "--wrangler") out.mode = "wrangler";
    else if (raw === "--s3") out.mode = "s3";
    else if (raw === "--html") out.format = "html";
    else if (raw === "--json" || raw === "--jsonl") out.format = "jsonl";
    else if (raw === "--unsafe") out.unsafe = true;
  }
  return out;
}

function extensionFor(format: Format): string {
  return format === "html" ? "html" : "jsonl";
}

function contentTypeFor(format: Format): string {
  return format === "html" ? "text/html; charset=utf-8" : "application/x-ndjson; charset=utf-8";
}

function publicUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Add it to your shell env, e.g. ~/.zshrc.`);
  return value;
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeout ? setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeout) : undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) stderr += `\nTimed out after ${options.timeout}ms`;
      resolve({ code, stdout, stderr });
    });
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function exportHtmlWithCurrentPi(sessionFile: string, outputPath: string, cwd: string): Promise<void> {
  const timeout = Number(process.env.PI_SHARE_EXPORT_TIMEOUT_MS || 120_000);
  const candidates: Array<{ label: string; command: string; args: string[] }> = [];
  const seen = new Set<string>();
  const add = (label: string, command: string, args: string[] = []) => {
    const key = `${command}\0${args.join("\0")}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({ label, command, args });
    }
  };

  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (agentDir) {
    const tiaPi = path.join(path.dirname(agentDir), "bin", "pi");
    if (await exists(tiaPi)) add("tia bundled pi", tiaPi);
  }

  if (process.execPath && path.basename(process.execPath).startsWith("pi") && await exists(process.execPath)) {
    add("current executable", process.execPath);
  }
  if (process.argv[1] && await exists(process.argv[1])) {
    add("current node/bun entrypoint", process.execPath, [process.argv[1]]);
  }

  add("tia pi", "tia", ["pi"]);
  add("pi on PATH", "pi");

  const sourceFile = await exists(sessionFile) ? sessionFile : await createExportableEmptySession(sessionFile, cwd);

  const failures: string[] = [];
  for (const c of candidates) {
    try {
      const res = await run(c.command, [...c.args, "--export", sourceFile, outputPath], { timeout });
      if (res.code === 0) return;
      failures.push(`${c.label}: exit ${res.code}\n${res.stderr || res.stdout}`.trim());
    } catch (err) {
      failures.push(`${c.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`pi export failed; tried ${candidates.map((c) => c.label).join(", ")}\n\n${failures.join("\n\n")}`);
}

async function createExportableEmptySession(sessionFile: string, cwd: string): Promise<string> {
  const dir = path.join(tmpdir(), "pi-r2-share");
  const id = path.basename(sessionFile, ".jsonl") || randomUUID();
  const tempSession = path.join(dir, `${id}.empty.jsonl`);
  await mkdir(dir, { recursive: true });
  await writeFile(tempSession, emptySessionJsonl(cwd, id, new Date().toISOString()), "utf8");
  return tempSession;
}

async function injectSessionMetadata(outputPath: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  let html = await readFile(outputPath, "utf8");
  const match = html.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return;

  const data = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  const allTools = pi.getAllTools();
  const activeToolNames = new Set(pi.getActiveTools());
  data.systemPrompt = ctx.getSystemPrompt();
  data.tools = allTools
    .filter((tool) => activeToolNames.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

  const sessionData = Buffer.from(JSON.stringify(data)).toString("base64");
  html = html.replace(match[1], sessionData);

  const toolsCollapsePatch = String.raw`
  <style>
    .tools-list.pi-r2-share-tools-collapsible .tools-header {
      cursor: pointer;
    }
    .tools-list.pi-r2-share-tools-collapsible:not(.expanded) .tools-content > .tool-item:nth-child(n+11) {
      display: none;
    }
    .tools-list.pi-r2-share-tools-collapsible.expanded .pi-r2-share-tools-expand-hint {
      display: none;
    }
    .pi-r2-share-tools-expand-hint {
      color: var(--muted);
      font-style: italic;
      margin-top: 4px;
      cursor: pointer;
    }
  </style>
  <script>
    (() => {
      const previewTools = 10;
      const applyToolsCollapse = () => {
        document.querySelectorAll('.tools-list:not([data-pi-r2-share-collapse])').forEach((list) => {
          const items = list.querySelectorAll('.tools-content > .tool-item');
          if (items.length <= previewTools) return;

          list.dataset.piR2ShareCollapse = '1';
          list.classList.add('pi-r2-share-tools-collapsible');

          const hint = document.createElement('div');
          hint.className = 'pi-r2-share-tools-expand-hint';
          hint.textContent = '... (' + (items.length - previewTools) + ' more tools, click to expand)';
          list.appendChild(hint);

          const toggle = () => {
            if (window.getSelection && window.getSelection().toString()) return;
            list.classList.toggle('expanded');
          };
          hint.addEventListener('click', toggle);
          list.querySelector('.tools-header')?.addEventListener('click', toggle);
        });
      };

      applyToolsCollapse();
      const header = document.getElementById('header-container');
      if (header) new MutationObserver(applyToolsCollapse).observe(header, { childList: true, subtree: true });
    })();
  </script>`;

  await writeFile(outputPath, html.replace("</body>", `${toolsCollapsePatch}\n</body>`), "utf8");
}

async function uploadWithWrangler(bucket: string, key: string, file: string, contentType: string): Promise<void> {
  const wranglerBin = process.env.PI_SHARE_WRANGLER_BIN || "wrangler";
  const args = ["r2", "object", "put", `${bucket}/${key}`, "--file", file, "--content-type", contentType, "--remote"];
  const res = await run(wranglerBin, args, { timeout: Number(process.env.PI_SHARE_UPLOAD_TIMEOUT_MS || 120_000) });
  if (res.code !== 0) throw new Error(`wrangler upload failed (${res.code})\n${res.stderr || res.stdout}`.trim());
}

async function deleteWithWrangler(bucket: string, key: string): Promise<void> {
  const wranglerBin = process.env.PI_SHARE_WRANGLER_BIN || "wrangler";
  const args = ["r2", "object", "delete", `${bucket}/${key}`, "--remote"];
  const res = await run(wranglerBin, args, { timeout: Number(process.env.PI_SHARE_DELETE_TIMEOUT_MS || 120_000) });
  if (res.code !== 0) throw new Error(`wrangler delete failed (${res.code})\n${res.stderr || res.stdout}`.trim());
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function awsDate(date: Date): { amz: string; short: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz: iso, short: iso.slice(0, 8) };
}

function r2S3Config() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.PI_SHARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error("S3 mode needs CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY env vars");
  return { accountId, accessKeyId, secretAccessKey };
}

function signedS3Headers(method: "PUT" | "DELETE", bucket: string, key: string, body: Buffer | string, contentType?: string) {
  const { accountId, accessKeyId, secretAccessKey } = r2S3Config();
  const now = new Date();
  const { amz, short } = awsDate(now);
  const region = "auto";
  const service = "s3";
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const pathname = `/${bucket}/${encodedKey}`;
  const payloadHash = sha256Hex(body);
  const headers: Record<string, string> = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amz };
  if (contentType) headers["content-type"] = contentType;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join("");
  const canonicalRequest = [method, pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${short}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amz, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${secretAccessKey}`, short);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `https://${host}${pathname}`, headers: { ...headers, authorization } };
}

async function uploadWithS3(bucket: string, key: string, file: string, contentType: string): Promise<void> {
  const body = await readFile(file);
  const signed = signedS3Headers("PUT", bucket, key, body, contentType);
  const res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body });
  if (!res.ok) throw new Error(`R2 S3 upload failed: HTTP ${res.status} ${res.statusText}\n${await res.text()}`);
}

async function deleteWithS3(bucket: string, key: string): Promise<void> {
  const signed = signedS3Headers("DELETE", bucket, key, Buffer.alloc(0));
  const res = await fetch(signed.url, { method: "DELETE", headers: signed.headers });
  if (!res.ok) throw new Error(`R2 S3 delete failed: HTTP ${res.status} ${res.statusText}\n${await res.text()}`);
}

async function uploadObject(bucket: string, key: string, file: string, contentType: string, mode: Mode): Promise<void> {
  if (mode === "s3") return uploadWithS3(bucket, key, file, contentType);
  if (mode === "wrangler") return uploadWithWrangler(bucket, key, file, contentType);
  if ((process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID) && (process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY)) {
    return uploadWithS3(bucket, key, file, contentType);
  }
  return uploadWithWrangler(bucket, key, file, contentType);
}

async function deleteObject(bucket: string, key: string, mode: Mode): Promise<void> {
  if (mode === "s3") return deleteWithS3(bucket, key);
  if (mode === "wrangler") return deleteWithWrangler(bucket, key);
  if ((process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID) && (process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY)) {
    return deleteWithS3(bucket, key);
  }
  return deleteWithWrangler(bucket, key);
}

async function listRemoteObjects(bucket: string, publicBaseUrl: string): Promise<RemoteObject[]> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.PI_SHARE_ACCOUNT_ID;
  if (!accountId) throw new Error("Remote listing needs CLOUDFLARE_ACCOUNT_ID or PI_SHARE_ACCOUNT_ID");

  const token = await getCloudflareApiToken();
  const objects: RemoteObject[] = [];
  let cursor: string | undefined;

  do {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`);
    url.searchParams.set("per_page", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data: any = await res.json().catch(() => undefined);
    if (!res.ok || !data?.success) {
      const detail = data?.errors?.map((e: any) => e.message).join("; ") || `${res.status} ${res.statusText}`;
      throw new Error(`Cloudflare R2 list failed: ${detail}`);
    }

    for (const item of data.result || []) {
      if (typeof item.key !== "string") continue;
      objects.push({
        key: item.key,
        url: publicUrl(publicBaseUrl, item.key),
        contentType: item.http_metadata?.contentType,
        lastModified: item.last_modified,
      });
    }

    cursor = data.result_info?.is_truncated ? data.result_info.cursor : undefined;
  } while (cursor);

  return objects;
}

async function getCloudflareApiToken(): Promise<string> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (apiToken) return apiToken;

  const wranglerBin = process.env.PI_SHARE_WRANGLER_BIN || "wrangler";
  await run(wranglerBin, ["r2", "bucket", "list"], { timeout: Number(process.env.PI_SHARE_LIST_TIMEOUT_MS || 120_000) }).catch(() => undefined);

  const configPath = path.join(homedir(), ".config", ".wrangler", "config", "default.toml");
  const config = await readFile(configPath, "utf8");
  const match = config.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("Could not find Wrangler OAuth token. Run `wrangler login` or set CLOUDFLARE_API_TOKEN.");
  return match[1];
}

async function loadSessionRecords(): Promise<ShareRecord[]> {
  const local = await readRegistry();
  const bucket = requiredEnv("PI_SHARE_BUCKET");
  const publicBaseUrl = requiredEnv("PI_SHARE_PUBLIC_URL");
  const remoteObjects = await listRemoteObjects(bucket, publicBaseUrl);
  return remoteObjectsToShareRecords(remoteObjects, local, fetchText);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

async function copyToClipboard(text: string): Promise<string> {
  const timeout = Number(process.env.PI_SHARE_CLIPBOARD_TIMEOUT_MS || 5_000);

  if (process.platform === "darwin" && await commandExists("pbcopy")) {
    const result = await runWithInput("pbcopy", [], text, timeout);
    if (result.code === 0) return "pbcopy";
  }

  if (process.platform === "win32" && await commandExists("clip.exe")) {
    const result = await runWithInput("clip.exe", [], text, timeout);
    if (result.code === 0) return "clip.exe";
  }

  const linuxCommands = [
    { command: "wl-copy", args: "" },
    { command: "xclip", args: "-selection clipboard" },
    { command: "xsel", args: "--clipboard --input" },
  ];
  for (const candidate of linuxCommands) {
    if (!await commandExists(candidate.command)) continue;
    const result = await run("sh", ["-lc", `printf %s ${shellQuote(text)} | ${candidate.command} ${candidate.args} >/dev/null 2>&1 &`], { timeout });
    if (result.code === 0) return candidate.command;
  }

  throw new Error("No clipboard command found (tried pbcopy, wl-copy, xclip, xsel, clip.exe)");
}

async function commandExists(command: string): Promise<boolean> {
  const result = process.platform === "win32"
    ? await run("where", [command], { timeout: 5_000 }).catch(() => ({ code: 1 }))
    : await run("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], { timeout: 5_000 }).catch(() => ({ code: 1 }));
  return result.code === 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runWithInput(command: string, args: readonly string[], input: string, timeout: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref?.();
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) stderr += `\nTimed out after ${timeout}ms`;
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function makeShareId(): string {
  // Unique locally and remotely without listing/searching either location.
  return randomUUID();
}

function getRedactionConfig(): RedactionConfig {
  const extra = process.env.PI_SHARE_ADDITIONAL_SECRETS?.trim();
  return {
    enabled: true,
    additionalSecrets: extra ? extra.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
  };
}

function checkTruffleHogAvailable(): boolean {
  return spawnSync("trufflehog", ["--version"], { encoding: "utf-8", timeout: 10_000 }).status === 0;
}

async function runRedactAndScan(opts: {
  file: string;
  format: string;
  config: ReturnType<typeof getRedactionConfig>;
  prefixes: string[];
}): Promise<{ findings: number }> {
  const { Worker } = await import("node:worker_threads");
  const workerFile = path.join(tmpdir(), `pi-r2-worker-${Date.now()}.mjs`);
  const timeoutMs = Number(process.env.PI_SHARE_TRUFFLEHOG_TIMEOUT_MS || 120_000);
  const extDir = path.dirname(new URL(import.meta.url).pathname);
  await writeFile(workerFile, `
import { parentPort } from "node:worker_threads";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { sanitizeHtmlSession, sanitizeJsonl, stripAbsolutePathPrefix } from "${extDir}/core.ts";
import { sanitizeForTelemetry, redactString } from "${extDir}/redaction.ts";

const data = JSON.parse(process.env.PI_R2_WORKER_DATA);
const config = { enabled: true, additionalSecrets: data.config.additionalSecrets };
let content = readFileSync(data.file, "utf8");
if (data.format === "html") {
  content = sanitizeHtmlSession(config, content);
} else {
  content = sanitizeJsonl(config, content);
}
content = stripAbsolutePathPrefix(content, data.prefixes);
writeFileSync(data.file, content, "utf8");

const result = spawnSync("trufflehog", ["filesystem", "--json", data.file], {
  encoding: "utf-8",
  timeout: ${timeoutMs},
  maxBuffer: 20 * 1024 * 1024,
});
if (result.error) {
  parentPort.postMessage({ error: result.error.message });
} else {
  const combined = (result.stdout || "") + "\\n" + (result.stderr || "");
  const findings = combined.split(/\\r?\\n/).filter(line => {
    if (!line.startsWith("{")) return false;
    try {
      const parsed = JSON.parse(line);
      return "DetectorName" in parsed || "SourceMetadata" in parsed || "Raw" in parsed || "Redacted" in parsed;
    } catch { return false; }
  }).length;
  parentPort.postMessage({ findings });
}
`);
  const workerData = JSON.stringify({
    file: opts.file,
    format: opts.format,
    config: opts.config,
    prefixes: opts.prefixes,
  });
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { env: { ...process.env, PI_R2_WORKER_DATA: workerData } });
    worker.on("message", (msg: any) => {
      worker.terminate();
      unlink(workerFile).catch(() => {});
      if (msg.error) reject(new Error(`TruffleHog scan failed: ${msg.error}`));
      else resolve(msg);
    });
    worker.on("error", (err: Error) => {
      worker.terminate();
      unlink(workerFile).catch(() => {});
      reject(err);
    });
  });
}

async function chooseFormat(ctx: ExtensionCommandContext): Promise<Format> {
  if (!ctx.hasUI) return "html";

  return ctx.ui.custom<Format>((tui, theme, _keybindings, done) => {
    let selected = 0;
    let cached: string[] | undefined;

    function handleInput(data: string) {
      if (matchesKey(data, Key.up)) {
        selected = 0;
        cached = undefined;
        tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down)) {
        selected = 1;
        cached = undefined;
        tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        done(selected === 0 ? "html" : "jsonl");
        return;
      }
      if (matchesKey(data, Key.escape)) {
        done("html");
        return;
      }
    }

    function render(width: number) {
      if (cached) return cached;

      const lines: string[] = [];
      const add = (line = "") => lines.push(truncateToWidth(line, width));

      add(theme.fg("accent", "─".repeat(width)));
      add(`${theme.fg("accent", theme.bold(" Export format"))}`);
      add(theme.fg("dim", " \u2191\u2193 navigate \u2022 Enter select \u2022 Esc cancel (defaults to HTML)"));
      add("");

      const htmlLabel = selected === 0 ? "\u25cf HTML (web page)" : "\u25cb HTML (web page)";
      const jsonlLabel = selected === 1 ? "\u25cf JSONL (raw session)" : "\u25cb JSONL (raw session)";

      add(`  ${selected === 0 ? theme.fg("accent", htmlLabel) : theme.fg("text", htmlLabel)}`);
      add(`  ${selected === 1 ? theme.fg("accent", jsonlLabel) : theme.fg("text", jsonlLabel)}`);

      add("");
      add(theme.fg("accent", "─".repeat(width)));

      cached = lines;
      return lines;
    }

    return { render, invalidate: () => { cached = undefined; }, handleInput };
  });
}

function parseErrorMessage(raw: string): string {
  if (raw.includes("401") || raw.includes("Unauthorized") || raw.includes("Authentication error") || raw.includes("Invalid access token"))
    return "Cloudflare auth failed. Run `wrangler login` to refresh your token, then retry.";
  if (raw.includes("bucket does not exist") || raw.includes("The specified bucket does not exist"))
    return `Bucket not found. Create it with: wrangler r2 bucket create ${process.env.PI_SHARE_BUCKET || "<name>"}`;
  if (raw.includes("ECONNREFUSED") || raw.includes("ENOTFOUND") || raw.includes("fetch failed"))
    return "Network error. Check your internet connection and try again.";
  if (raw.includes("TruffleHog scan timed out"))
    return "TruffleHog scan timed out. Try again or use --unsafe to skip scanning.";
  const lines = raw.split("\n").filter((l) => l.trim() && !l.startsWith("\u2718") && !l.startsWith("{") && !l.includes("Logs were written"));
  return lines.join("\n").trim() || raw.slice(0, 200);
}

async function doShare(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  await ctx.waitForIdle();

  const sessionFile = ctx.sessionManager.getSessionFile?.();
  if (!sessionFile) {
    ctx.ui.notify("r2-share: no persistent session file to export", "error");
    return;
  }

  const opts = parseArgs(args);
  const bucket = requiredEnv("PI_SHARE_BUCKET");
  const publicBaseUrl = requiredEnv("PI_SHARE_PUBLIC_URL");
  const mode = opts.mode || (process.env.PI_SHARE_MODE as Mode) || "auto";
  const format = opts.format || (await chooseFormat(ctx));
  const ext = extensionFor(format);
  const shareId = makeShareId();
  const localDir = path.join(tmpdir(), "pi-r2-share");
  const outputPath = path.join(localDir, `${shareId}.${ext}`);
  const objectKey = format === "html" ? shareId : `${shareId}.${ext}`;
  const contentType = contentTypeFor(format);

  try {
    await mkdir(localDir, { recursive: true });

    if (format === "html") {
      await exportHtmlWithCurrentPi(sessionFile, outputPath, ctx.cwd);
      await injectSessionMetadata(outputPath, ctx, pi);
    } else if (await exists(sessionFile)) {
      await copyFile(sessionFile, outputPath);
    } else {
      await writeFile(outputPath, emptySessionJsonl(ctx.cwd, shareId, new Date().toISOString()), "utf8");
    }

    const doRedact = opts.unsafe ? false : await ctx.ui.confirm(
      "Redact secrets before sharing?",
      "The session will be scanned for API keys, tokens, PII, and credentials.\nRequires TruffleHog. Choose No to share raw.",
    );

    if (doRedact) {
      if (!checkTruffleHogAvailable()) {
        ctx.ui.notify("r2-share: TruffleHog is not installed. Safe sharing requires TruffleHog for secret scanning.\nInstall: https://github.com/trufflesecurity/trufflehog or run `brew install trufflehog`\nRe-run with --unsafe to share without redaction.", "error");
        return;
      }

      ctx.ui.notify("r2-share: redacting and scanning…", "info");
      const result = await runRedactAndScan({
        file: outputPath,
        format,
        config: getRedactionConfig(),
        prefixes: [process.env.HOME || "", ctx.cwd, sessionFile].filter(Boolean),
      });
      if (result.findings > 0) {
        ctx.ui.notify(`r2-share: TruffleHog found ${result.findings} potential secret(s) after redaction. Upload aborted.\nReview: ${outputPath}\nRe-run with --unsafe to share without redaction.`, "error");
        return;
      }
    }

    await uploadObject(bucket, objectKey, outputPath, contentType, mode);

    const shareUrl = publicUrl(publicBaseUrl, objectKey);
    const title = pi.getSessionName?.() || await getSessionTitle(sessionFile);
    await addShareRecord({
      id: shareId,
      key: objectKey,
      url: shareUrl,
      cwd: ctx.cwd,
      sessionFile,
      title,
      format,
      uploadedAt: new Date().toISOString(),
    });

    ctx.ui.notify(`r2-share: ${shareUrl}${opts.unsafe ? " (shared without redaction)" : ""}`, "info");
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`r2-share failed: ${parseErrorMessage(raw)}`, "error");
  }
}

async function doSessions(args: string, ctx: ExtensionCommandContext) {
  await ctx.waitForIdle();
  const opts = parseArgs(args);
  const mode = opts.mode || (process.env.PI_SHARE_MODE as Mode) || "auto";

  if (!ctx.hasUI) {
    const records = filterRecords(await loadSessionRecords(), ctx.cwd, args.includes("--all"));
    ctx.ui.notify(records.map((r) => `${r.title}\n${r.url}`).join("\n\n") || "No uploaded R2 sessions found", "info");
    return;
  }

  let showAll = args.includes("--all");
  let selected = 0;
  let records: ShareRecord[];
  try {
    ctx.ui.notify("r2-sessions: loading R2 objects…", "info");
    records = await loadSessionRecords();
  } catch (err) {
    ctx.ui.notify(`r2-sessions remote listing failed, showing local registry only: ${err instanceof Error ? err.message : String(err)}`, "warning");
    records = await readRegistry();
  }

  while (true) {
    const visible = filterRecords(records, ctx.cwd, showAll);
    if (selected >= visible.length) selected = Math.max(0, visible.length - 1);

    const action = await ctx.ui.custom<BrowserAction>((tui, theme, _keybindings, done) => {
      let cached: string[] | undefined;
      let showSelectedId = false;
      let copyStatus: { kind: "success" | "error" | "pending"; message: string; token: number } | undefined;
      const refresh = () => {
        cached = undefined;
        tui.requestRender();
      };

      const currentVisible = () => filterRecords(records, ctx.cwd, showAll);
      const setCopyStatus = (kind: "success" | "error" | "pending", message: string) => {
        const token = Date.now();
        copyStatus = { kind, message, token };
        refresh();
        if (kind !== "pending") {
          setTimeout(() => {
            if (copyStatus?.token === token) {
              copyStatus = undefined;
              refresh();
            }
          }, 2_500);
        }
      };

      function handleInput(data: string) {
        const visible = currentVisible();
        if (matchesKey(data, Key.escape)) return done({ type: "close" });
        if (matchesKey(data, Key.tab)) {
          showAll = !showAll;
          selected = 0;
          return refresh();
        }
        if (matchesKey(data, Key.up)) {
          selected = Math.max(0, selected - 1);
          return refresh();
        }
        if (matchesKey(data, Key.down)) {
          selected = Math.min(visible.length - 1, selected + 1);
          return refresh();
        }
        if (matchesKey(data, Key.enter) && visible[selected]) {
          const record = visible[selected];
          setCopyStatus("pending", "Copying share URL…");
          copyToClipboard(record.url)
            .then(() => setCopyStatus("success", "✓ Copied share URL to clipboard"))
            .catch((err) => setCopyStatus("error", `Could not copy automatically: ${err instanceof Error ? err.message : String(err)}`));
          return;
        }
        if (matchesKey(data, "i") && visible[selected]) {
          showSelectedId = !showSelectedId;
          return refresh();
        }
        if (matchesKey(data, "d") && visible[selected]) return done({ type: "delete", record: visible[selected] });
        if (matchesKey(data, "shift+d") && visible.length > 0) return done({ type: "delete-visible", records: visible });
      }

      function render(width: number) {
        if (cached) return cached;
        const visible = currentVisible();
        if (selected >= visible.length) selected = Math.max(0, visible.length - 1);
        const lines: string[] = [];
        const add = (line = "") => lines.push(truncateToWidth(line, width));
        add(theme.fg("accent", "─".repeat(width)));
        add(`${theme.fg("accent", theme.bold(" R2 sessions"))} ${theme.fg("muted", showAll ? "all uploaded sessions" : `cwd: ${ctx.cwd}`)}`);
        add(theme.fg("dim", " Tab toggle cwd/all • ↑↓ select • Enter copy URL • i show ID • d delete • D delete visible • Esc close"));
        if (copyStatus) {
          const color = copyStatus.kind === "success" ? "success" : copyStatus.kind === "error" ? "warning" : "muted";
          add(theme.fg(color, ` ${copyStatus.message}`));
        }
        add("");

        if (visible.length === 0) {
          add(theme.fg("warning", showAll ? " No uploaded R2 sessions found." : " No uploaded R2 sessions for this cwd."));
        } else {
          for (let i = 0; i < visible.length; i++) {
            const record = visible[i];
            const isSelected = i === selected;
            const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
            const title = isSelected ? theme.fg("accent", record.title) : theme.fg("text", record.title);
            const scope = showAll ? ` ${record.cwd}` : "";
            add(`${prefix}${title} ${theme.fg("muted", `[${record.format}] ${new Date(record.uploadedAt).toLocaleString()}${scope}`)}`);
            if (isSelected && showSelectedId) add(`  ${theme.fg("dim", record.key)}`);
          }
        }

        add("");
        add(theme.fg("accent", "─".repeat(width)));
        cached = lines;
        return lines;
      }

      return { render, invalidate: () => { cached = undefined; }, handleInput };
    });

    if (action.type === "close") return;
    if (action.type === "delete") {
      const ok = await ctx.ui.confirm("Delete uploaded session?", `${action.record.title}\n\n${action.record.url}`);
      if (!ok) continue;
      try {
        const bucket = requiredEnv("PI_SHARE_BUCKET");
        await deleteObject(bucket, action.record.key, mode);
        await removeShareRecords(new Set([action.record.id]));
        records = records.filter((record) => record.id !== action.record.id && record.key !== action.record.key);
        ctx.ui.notify(`Deleted ${action.record.title}`, "info");
      } catch (err) {
        ctx.ui.notify(`r2-sessions delete failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
      continue;
    }
    if (action.type === "delete-visible") {
      const ok = await ctx.ui.confirm("Delete all visible uploaded sessions?", `This will delete ${action.records.length} R2 object(s).`);
      if (!ok) continue;
      const deleted = new Set<string>();
      for (const record of action.records) {
        try {
          const bucket = requiredEnv("PI_SHARE_BUCKET");
          await deleteObject(bucket, record.key, mode);
          deleted.add(record.id);
        } catch (err) {
          ctx.ui.notify(`Failed deleting ${record.title}: ${err instanceof Error ? err.message : String(err)}`, "error");
          break;
        }
      }
      if (deleted.size > 0) {
        await removeShareRecords(deleted);
        records = records.filter((record) => !deleted.has(record.id));
        ctx.ui.notify(`Deleted ${deleted.size} uploaded session(s)`, "info");
      }
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("r2-share", {
    description: "Export current session and upload/share via Cloudflare R2",
    handler: (args, ctx) => doShare(args, ctx, pi),
  });

  pi.registerCommand("r2-sessions", {
    description: "Browse, copy, and delete sessions uploaded to Cloudflare R2",
    handler: (args, ctx) => doSessions(args, ctx),
  });
}
