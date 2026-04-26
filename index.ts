import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";

type Format = "html" | "jsonl";
type Mode = "auto" | "wrangler" | "s3";
type RunResult = { code: number | null; stdout: string; stderr: string };

type ShareOptions = {
  format?: Format;
  mode?: Mode;
};

function parseArgs(args: string): ShareOptions {
  const out: ShareOptions = {};
  const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/^"|"$/g, "")) ?? [];
  for (const raw of tokens) {
    if (raw === "--wrangler") out.mode = "wrangler";
    else if (raw === "--s3") out.mode = "s3";
    else if (raw === "--html") out.format = "html";
    else if (raw === "--json" || raw === "--jsonl") out.format = "jsonl";
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

async function exportHtmlWithCurrentPi(sessionFile: string, outputPath: string): Promise<void> {
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

  const failures: string[] = [];
  for (const c of candidates) {
    try {
      const res = await run(c.command, [...c.args, "--export", sessionFile, outputPath], { timeout });
      if (res.code === 0) return;
      failures.push(`${c.label}: exit ${res.code}\n${res.stderr || res.stdout}`.trim());
    } catch (err) {
      failures.push(`${c.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`pi export failed; tried ${candidates.map((c) => c.label).join(", ")}\n\n${failures.join("\n\n")}`);
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
    .tools-list.pi-share-tools-collapsible .tools-header {
      cursor: pointer;
    }
    .tools-list.pi-share-tools-collapsible:not(.expanded) .tools-content > .tool-item:nth-child(n+11) {
      display: none;
    }
    .tools-list.pi-share-tools-collapsible.expanded .pi-share-tools-expand-hint {
      display: none;
    }
    .pi-share-tools-expand-hint {
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
        document.querySelectorAll('.tools-list:not([data-pi-share-collapse])').forEach((list) => {
          const items = list.querySelectorAll('.tools-content > .tool-item');
          if (items.length <= previewTools) return;

          list.dataset.piShareCollapse = '1';
          list.classList.add('pi-share-tools-collapsible');

          const hint = document.createElement('div');
          hint.className = 'pi-share-tools-expand-hint';
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

async function uploadWithS3(bucket: string, key: string, file: string, contentType: string): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.PI_SHARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error("S3 mode needs CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY env vars");

  const body = await readFile(file);
  const now = new Date();
  const { amz, short } = awsDate(now);
  const region = "auto";
  const service = "s3";
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const pathname = `/${bucket}/${encodedKey}`;
  const payloadHash = sha256Hex(body);
  const headers: Record<string, string> = { host, "content-type": contentType, "x-amz-content-sha256": payloadHash, "x-amz-date": amz };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join("");
  const canonicalRequest = ["PUT", pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${short}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amz, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${secretAccessKey}`, short);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}${pathname}`, { method: "PUT", headers: { ...headers, authorization }, body });
  if (!res.ok) throw new Error(`R2 S3 upload failed: HTTP ${res.status} ${res.statusText}\n${await res.text()}`);
}

async function uploadObject(bucket: string, key: string, file: string, contentType: string, mode: Mode): Promise<void> {
  if (mode === "s3") return uploadWithS3(bucket, key, file, contentType);
  if (mode === "wrangler") return uploadWithWrangler(bucket, key, file, contentType);
  if ((process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID) && (process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY)) {
    return uploadWithS3(bucket, key, file, contentType);
  }
  return uploadWithWrangler(bucket, key, file, contentType);
}

function makeShareId(): string {
  // Unique locally and remotely without listing/searching either location.
  return randomUUID();
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
  const format = opts.format || "html";
  const ext = extensionFor(format);
  const shareId = makeShareId();
  const localDir = path.join(tmpdir(), "pi-r2-share");
  const outputPath = path.join(localDir, `${shareId}.${ext}`);
  const objectKey = format === "html" ? shareId : `${shareId}.${ext}`;
  const contentType = contentTypeFor(format);

  try {
    await mkdir(localDir, { recursive: true });
    ctx.ui.notify(`r2-share: exporting ${format.toUpperCase()}…`, "info");

    if (format === "html") {
      await exportHtmlWithCurrentPi(sessionFile, outputPath);
      await injectSessionMetadata(outputPath, ctx, pi);
    } else {
      await copyFile(sessionFile, outputPath);
    }

    ctx.ui.notify(`r2-share: uploading R2 object ${bucket}/${objectKey}…`, "info");
    await uploadObject(bucket, objectKey, outputPath, contentType, mode);

    const shareUrl = publicUrl(publicBaseUrl, objectKey);
    ctx.ui.notify(`Saved: ${outputPath}\nShare URL: ${shareUrl}`, "info");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`r2-share failed: ${message}`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("r2-share", {
    description: "Export current session and upload/share via Cloudflare R2",
    handler: (args, ctx) => doShare(args, ctx, pi),
  });
}
