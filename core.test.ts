import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addShareRecord,
  filterRecords,
  getSessionTitle,
  mergeShareRecords,
  parseExportedHtml,
  remoteObjectToShareRecord,
  readRegistry,
  removeShareRecords,
  type ShareRecord,
} from "./core";

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "pi-share-test-"));
}

function record(overrides: Partial<ShareRecord> = {}): ShareRecord {
  return {
    id: "id-1",
    key: "id-1",
    url: "https://r2.example/id-1",
    cwd: "/repo/a",
    sessionFile: "/home/me/.pi/agent/sessions/a.jsonl",
    title: "Session A",
    format: "html",
    uploadedAt: "2026-04-26T10:00:00.000Z",
    ...overrides,
  };
}

describe("R2 upload registry", () => {
  test("records successful uploads and lists newest first", async () => {
    const dir = await tempDir();
    const registry = path.join(dir, "uploads.json");
    try {
      await addShareRecord(record({ id: "old", uploadedAt: "2026-04-26T09:00:00.000Z" }), registry);
      await addShareRecord(record({ id: "new", key: "new", url: "https://r2.example/new" }), registry);

      const records = filterRecords(await readRegistry(registry), "/repo/a", false);
      expect(records.map((r) => r.id)).toEqual(["new", "old"]);
      expect(JSON.parse(await readFile(registry, "utf8"))).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("filters by cwd unless all sessions mode is enabled", () => {
    const records = [record({ id: "a", cwd: "/repo/a" }), record({ id: "b", cwd: "/repo/b" })];
    expect(filterRecords(records, "/repo/a", false).map((r) => r.id)).toEqual(["a"]);
    expect(filterRecords(records, "/repo/a", true).map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  test("removes selected upload records", async () => {
    const dir = await tempDir();
    const registry = path.join(dir, "uploads.json");
    try {
      await addShareRecord(record({ id: "a" }), registry);
      await addShareRecord(record({ id: "b", key: "b", url: "https://r2.example/b" }), registry);

      const remaining = await removeShareRecords(new Set(["a"]), registry);
      expect(remaining.map((r) => r.id)).toEqual(["b"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merges remote R2 objects with richer local metadata", () => {
    const remote = record({ id: "remote-key", key: "same-key", title: "Remote fallback", cwd: "(unknown cwd)" });
    const local = record({ id: "local-id", key: "same-key", title: "Local title", cwd: "/repo/a" });

    expect(mergeShareRecords([local], [remote])).toEqual([local]);
  });

  test("does not show stale local records after remote listing succeeds", () => {
    const stale = record({ id: "stale", key: "deleted-key" });
    const remote = record({ id: "remote", key: "remote-key" });

    expect(mergeShareRecords([stale], [remote]).map((r) => r.key)).toEqual(["remote-key"]);
  });
});

describe("remote session metadata extraction", () => {
  test("extracts cwd and session name from exported HTML", () => {
    const data = {
      header: { cwd: "/repo/a" },
      entries: [
        { type: "message", message: { role: "user", content: "First prompt" } },
        { type: "session_info", name: "Named session" },
      ],
    };
    const encoded = Buffer.from(JSON.stringify(data)).toString("base64");
    const html = `<script id="session-data" type="application/json">${encoded}</script>`;

    expect(parseExportedHtml(html)).toEqual({ cwd: "/repo/a", title: "Named session" });
  });

  test("builds a share record from a remote object and public exported content", async () => {
    const jsonl = [
      JSON.stringify({ type: "session", cwd: "/repo/b" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Remote prompt" } }),
      "",
    ].join("\n");

    const result = await remoteObjectToShareRecord(
      { key: "abc.jsonl", url: "https://r2.example/abc.jsonl", contentType: "application/x-ndjson", lastModified: "2026-04-26T12:00:00.000Z" },
      async () => jsonl,
    );

    expect(result).toMatchObject({ key: "abc.jsonl", cwd: "/repo/b", title: "Remote prompt", format: "jsonl" });
  });
});

describe("session title extraction", () => {
  test("uses the latest pi session name when present", async () => {
    const dir = await tempDir();
    const session = path.join(dir, "session.jsonl");
    try {
      await writeFile(
        session,
        [
          JSON.stringify({ type: "session", version: 3, cwd: "/repo/a" }),
          JSON.stringify({ type: "message", message: { role: "user", content: "First prompt" } }),
          JSON.stringify({ type: "session_info", name: "Actual pi title" }),
          "",
        ].join("\n"),
      );
      expect(await getSessionTitle(session)).toBe("Actual pi title");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to first user message", async () => {
    const dir = await tempDir();
    const session = path.join(dir, "session.jsonl");
    try {
      await writeFile(
        session,
        `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Build a thing" }] } })}\n`,
      );
      expect(await getSessionTitle(session)).toBe("Build a thing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
