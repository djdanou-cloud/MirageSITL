import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_VIEWER_LOG_BYTES, dataflashRefusal, loadLogMessage, parseViewerBuild, parseViewerMessage, viewerLogName,
} from "../apps/web/src/analysis/viewer-protocol";
import {
  BUILD_MANIFEST, PATCH_DIRECTORY, checkBuildManifest, patchSeries, readLock, treeDigest, treeFiles, type ViewerLock,
} from "../scripts/uavlogviewer/build-rules";

// TASK-179: the host half of the viewer message interface and the build's
// identity rules. The build itself and the offline smoke run against the pinned
// source in scripts/build-uavlogviewer.mjs and tests/browser/log-viewer.spec.ts.
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("viewer messages", () => {
  it("accepts the four protocol 1 messages and nothing else", () => {
    expect(parseViewerMessage({ type: "mirage.ready", protocol: 1 })).toEqual({ type: "mirage.ready" });
    expect(parseViewerMessage({ type: "mirage.logAccepted", protocol: 1, name: "a.bin", bytes: 10 })).toEqual({ type: "mirage.logAccepted", name: "a.bin", bytes: 10 });
    expect(parseViewerMessage({ type: "mirage.logRejected", protocol: 1, reason: "no" })).toEqual({ type: "mirage.logRejected", reason: "no" });
    expect(parseViewerMessage({ type: "mirage.logParsed", protocol: 1, name: "a.bin", messageTypes: 168 })).toEqual({ type: "mirage.logParsed", name: "a.bin", messageTypes: 168 });
    for (const bad of [null, "mirage.ready", { type: "mirage.ready" }, { type: "mirage.ready", protocol: 2 }, { type: "arrayBuffer", protocol: 1 },
      { type: "mirage.logParsed", protocol: 1, name: "a.bin", messageTypes: -1 }, { type: "mirage.logAccepted", protocol: 1, name: 3, bytes: 1 },
      { type: "mirage.logParsed", protocol: 1, name: "a.bin", messageTypes: 1.5 }]) {
      expect(parseViewerMessage(bad)).toBeNull();
    }
  });

  it("refuses files that are not DataFlash logs before sending them", () => {
    expect(dataflashRefusal("a.bin", new Uint8Array([0xa3, 0x95, 0x80]))).toBeNull();
    expect(dataflashRefusal("a.bin", new Uint8Array())).toContain("empty");
    expect(dataflashRefusal("a.tlog", new Uint8Array([0xfd, 0x09]))).toContain("0xA3 0x95");
    expect(dataflashRefusal("big.bin", { length: MAX_VIEWER_LOG_BYTES + 1, 0: 0xa3, 1: 0x95 })).toContain("limit");
  });

  it("keeps log names within the viewer's name rule", () => {
    expect(viewerLogName("00000001.BIN")).toBe("00000001.BIN");
    expect(viewerLogName("dir/sub\\x.bin")).toBe("dir_sub_x.bin");
    expect(viewerLogName("a\u0001b")).toBe("a_b");
    expect(viewerLogName("")).toBe("log.bin");
    expect(viewerLogName("x".repeat(300))).toHaveLength(255);
    const bytes = new ArrayBuffer(2);
    expect(loadLogMessage("a/b.bin", bytes)).toEqual({ type: "mirage.loadLog", protocol: 1, name: "a_b.bin", bytes });
  });

  it("reads only TASK-179 build manifests", () => {
    const manifest = { schemaVersion: 1, task: "TASK-179", commit: "a".repeat(40), patches: [{}, {}, {}], outputs: { files: 3, sha256: "b".repeat(64) } };
    expect(parseViewerBuild(manifest)).toEqual({ commit: "a".repeat(40), patches: 3, files: 3, digest: "b".repeat(64) });
    expect(parseViewerBuild({ ...manifest, task: "TASK-130" })).toBeNull();
    expect(parseViewerBuild({ ...manifest, commit: "short" })).toBeNull();
    expect(parseViewerBuild({ ...manifest, outputs: { files: 3, sha256: "x" } })).toBeNull();
  });
});

describe("viewer build identity", () => {
  it("applies the four repository patches in name order, each touching only upstream paths it names", () => {
    const series = patchSeries();
    expect(series.map(patch => patch.file)).toEqual(["0000-compatibility.patch", "0001-offline.patch", "0002-message-interface.patch", "0003-experiment-context.patch"]);
    for (const patch of series) {
      const text = readFileSync(join(PATCH_DIRECTORY, patch.file), "utf8");
      expect(sha256(text)).toBe(patch.sha256);
      // Every changed path is relative to the upstream checkout.
      for (const [, path] of text.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)) expect(path).not.toMatch(/^(\/|\.\.)/);
    }
    // The offline patch removes every online dependency the TASK-130 smoke test aborted.
    const offline = readFileSync(join(PATCH_DIRECTORY, "0001-offline.patch"), "utf8");
    for (const removed of ["googletagmanager.com", "use.fontawesome.com", "fonts.googleapis.com", "is-online", "api.maptiler.com"]) {
      expect(offline).toMatch(new RegExp(`^-.*${removed.replace(/\./g, "\\.")}`, "m"));
    }
    // The message interface replaces the listener that accepted any origin.
    expect(readFileSync(join(PATCH_DIRECTORY, "0002-message-interface.patch"), "utf8")).toMatch(/^-\s+if \(event\.data\.type === 'arrayBuffer'\) \{$/m);
  });

  it("digests a tree as sorted path and SHA-256 lines without the build manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "mirage-viewer-tree-"));
    try {
      mkdirSync(join(directory, "static"));
      writeFileSync(join(directory, "index.html"), "<html></html>");
      writeFileSync(join(directory, "static", "app.js"), "1");
      writeFileSync(join(directory, BUILD_MANIFEST), "{}");
      const files = treeFiles(directory);
      expect(files.map(file => file.path)).toEqual(["index.html", "static/app.js"]);
      expect(treeDigest(files)).toEqual({
        files: 2, bytes: 14, sha256: sha256(`index.html\t${sha256("<html></html>")}\nstatic/app.js\t${sha256("1")}\n`),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records the reproduced patched build in the source lock", () => {
    const lock = readLock();
    expect(lock.patchedBuild?.patches).toEqual(patchSeries());
    expect(lock.patchedBuild?.outputs.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a build manifest whose commit, patches or files differ", () => {
    const lock: ViewerLock = { ...readLock(), patchedBuild: null };
    const digest = { files: 2, bytes: 14, sha256: "c".repeat(64) };
    const series = [{ file: "0000-a.patch", sha256: "d".repeat(64) }];
    const manifest = { schemaVersion: 1, task: "TASK-179", commit: lock.commit, patches: series, outputs: digest };
    expect(checkBuildManifest(lock, manifest, digest, series)).toEqual({ verdict: "PASS", failures: [], patches: 1, matchesLockedBuild: false });
    expect(checkBuildManifest(lock, { ...manifest, commit: "e".repeat(40) }, digest, series).failures).toEqual([`the build is not of commit ${lock.commit}`]);
    expect(checkBuildManifest(lock, { ...manifest, patches: [] }, digest, series).failures).toEqual(["the build's patches differ from third_party/uavlogviewer/patches"]);
    expect(checkBuildManifest(lock, manifest, { ...digest, sha256: "f".repeat(64) }, series).failures).toEqual(["the files on disk differ from the build manifest"]);
    expect(checkBuildManifest(lock, { ...manifest, task: "TASK-130" }, digest, series).verdict).toBe("FAIL");
  });
});
