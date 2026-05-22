import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { redactString, sanitizeForTelemetry, type RedactionConfig } from "./redaction.ts";

export type Format = "html" | "jsonl";

export type ShareRecord = {
  id: string;
  key: string;
  url: string;
  cwd: string;
  sessionFile: string;
  title: string;
  format: Format;
  uploadedAt: string;
};

export type RemoteObject = {
  key: string;
  url: string;
  contentType?: string;
  lastModified?: string;
};

function cacheDir(): string {
  return path.join(homedir(), ".pi", "cache");
}

export function defaultRegistryPath(): string {
  return process.env.PI_SHARE_REGISTRY || path.join(cacheDir(), "r2-shares.json");
}

export async function readRegistry(file = defaultRegistryPath()): Promise<ShareRecord[]> {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(data)) return [];
    return data.filter(isShareRecord);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeRegistry(records: ShareRecord[], file = defaultRegistryPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export async function addShareRecord(record: ShareRecord, file = defaultRegistryPath()): Promise<ShareRecord[]> {
  const records = await readRegistry(file);
  const next = [record, ...records.filter((r) => r.id !== record.id)];
  await writeRegistry(next, file);
  return next;
}

export async function removeShareRecords(ids: Set<string>, file = defaultRegistryPath()): Promise<ShareRecord[]> {
  const records = await readRegistry(file);
  const next = records.filter((r) => !ids.has(r.id));
  await writeRegistry(next, file);
  return next;
}

export function filterRecords(records: ShareRecord[], cwd: string, showAll: boolean): ShareRecord[] {
  const filtered = showAll ? records : records.filter((r) => normalizePath(r.cwd) === normalizePath(cwd));
  return [...filtered].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export function mergeShareRecords(local: ShareRecord[], remote: ShareRecord[]): ShareRecord[] {
  const localByKey = new Map(local.map((record) => [record.key, record]));
  return remote
    .map((record) => ({ ...record, ...localByKey.get(record.key) }))
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export async function remoteObjectsToShareRecords(
  objects: RemoteObject[],
  local: ShareRecord[],
  fetchText: (url: string) => Promise<string>,
): Promise<ShareRecord[]> {
  const localByKey = new Map(local.map((record) => [record.key, record]));
  const records = await Promise.all(objects.map((object) => {
    const localRecord = localByKey.get(object.key);
    if (localRecord) return Promise.resolve(localRecord);
    return remoteObjectToShareRecord(object, fetchText);
  }));
  return records.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export async function remoteObjectToShareRecord(object: RemoteObject, fetchText: (url: string) => Promise<string>): Promise<ShareRecord> {
  const format: Format = object.key.endsWith(".jsonl") || object.contentType?.includes("json") || object.contentType?.includes("ndjson") ? "jsonl" : "html";
  const fallbackTitle = object.key;
  const fallbackCwd = "(unknown cwd)";
  const uploadedAt = object.lastModified || new Date(0).toISOString();

  try {
    const text = await fetchText(object.url);
    const parsed = format === "html" ? parseExportedHtml(text) : parseExportedJsonl(text);
    return {
      id: object.key,
      key: object.key,
      url: object.url,
      cwd: parsed.cwd || fallbackCwd,
      sessionFile: "",
      title: parsed.title || fallbackTitle,
      format,
      uploadedAt,
    };
  } catch {
    return {
      id: object.key,
      key: object.key,
      url: object.url,
      cwd: fallbackCwd,
      sessionFile: "",
      title: fallbackTitle,
      format,
      uploadedAt,
    };
  }
}

export function parseExportedHtml(html: string): { cwd?: string; title?: string } {
  const match = html.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return {};
  const data = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  return sessionDataInfo(data);
}

function parseExportedJsonl(jsonl: string): { cwd?: string; title?: string } {
  const entries: any[] = [];
  let header: any;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session") header = entry;
    else entries.push(entry);
  }
  return sessionDataInfo({ header, entries });
}

export async function getSessionTitle(sessionFile: string): Promise<string> {
  const fallback = path.basename(sessionFile).replace(/\.jsonl$/, "");
  let firstUser: string | undefined;
  let latestName: string | undefined;

  try {
    const text = await readFile(sessionFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
        latestName = entry.name.trim();
      }

      const message = entry.type === "message" ? entry.message : undefined;
      if (!firstUser && message?.role === "user") {
        firstUser = contentToText(message.content);
      }
    }
  } catch {
    return fallback;
  }

  return truncateTitle(latestName || firstUser || fallback);
}

function contentToText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join(" ")
    .trim();
  return text || undefined;
}

function truncateTitle(title: string, max = 80): string {
  const oneLine = title.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function emptySessionJsonl(cwd: string, id: string, timestamp: string): string {
  return `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd })}\n`;
}

function sessionDataInfo(data: any): { cwd?: string; title?: string } {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  let firstUser: string | undefined;
  let latestName: string | undefined;

  for (const entry of entries) {
    if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      latestName = entry.name.trim();
    }

    const message = entry?.type === "message" ? entry.message : undefined;
    if (!firstUser && message?.role === "user") {
      firstUser = contentToText(message.content);
    }
  }

  return {
    cwd: typeof data?.header?.cwd === "string" ? data.header.cwd : undefined,
    title: truncateTitle(latestName || firstUser || ""),
  };
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function isShareRecord(value: any): value is ShareRecord {
  return (
    value &&
    typeof value.id === "string" &&
    typeof value.key === "string" &&
    typeof value.url === "string" &&
    typeof value.cwd === "string" &&
    typeof value.sessionFile === "string" &&
    typeof value.title === "string" &&
    (value.format === "html" || value.format === "jsonl") &&
    typeof value.uploadedAt === "string"
  );
}

export function sanitizeJsonl(config: RedactionConfig, content: string, env?: NodeJS.ProcessEnv): string {
  const lines = content.split(/\r?\n/);
  const sanitizedLines = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const parsed = JSON.parse(line);
      return JSON.stringify(sanitizeForTelemetry(config, parsed, env));
    } catch {
      return redactString(config, line, env);
    }
  });
  return sanitizedLines.join("\n");
}

export function sanitizeHtmlSession(config: RedactionConfig, html: string, env?: NodeJS.ProcessEnv): string {
  const match = html.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return html;

  const data = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  const sanitized = sanitizeForTelemetry(config, data, env);
  const encoded = Buffer.from(JSON.stringify(sanitized)).toString("base64");

  return html.replace(match[1], encoded);
}

export function stripAbsolutePathPrefix(content: string, prefixes: string[]): string {
  if (!prefixes.length) return content;
  let output = content;
  for (const prefix of prefixes) {
    if (!prefix) continue;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(escaped, "g"), "[PATH_ROOT]");
  }
  return output;
}

