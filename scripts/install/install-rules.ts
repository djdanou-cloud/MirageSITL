// Rules of the macOS installer (TASK-152), separate from its side effects so
// they are tested directly: host checks and install-manifest items.

export const REQUIRED_NODE_MAJOR = 24;
export interface HostCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
  /** What the user does; empty when ok. */
  readonly fix: string;
}
export interface ManifestItem {
  readonly id: string;
  /** The config/offline-inventory.json row this item belongs to. */
  readonly inventoryId: string;
  readonly license: string;
  readonly version?: string;
  readonly path?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly [detail: string]: unknown;
}
export interface InstallManifest {
  readonly schemaVersion: 1;
  readonly items: readonly ManifestItem[];
  readonly [detail: string]: unknown;
}

/** Host checks; `probe` runs a command and returns its output, or null when it fails. */
export function hostChecks(host: { platform: string; arch: string; nodeVersion: string; probe: (command: string, args: string[]) => string | null }): HostCheck[] {
  const checks: HostCheck[] = [];
  const add = (id: string, ok: boolean, detail: string, fix: string) => checks.push({ id, ok, detail, fix: ok ? "" : fix });
  add("platform", host.platform === "darwin" && host.arch === "arm64", `${host.platform} ${host.arch}`, "Phase 1 installs on macOS with an Apple Silicon processor.");
  add("node", Number(host.nodeVersion.split(".")[0]) === REQUIRED_NODE_MAJOR, `Node.js ${host.nodeVersion}`, `Install Node.js ${REQUIRED_NODE_MAJOR} LTS (.nvmrc) and run the installer with it.`);
  const developer = host.probe("xcode-select", ["-p"]);
  add("xcode-tools", developer !== null, developer ?? "not installed", "Install the Xcode command line tools: xcode-select --install");
  const git = host.probe("git", ["--version"]);
  add("git", git !== null, git ?? "not found", "Install git with the Xcode command line tools.");
  const python = host.probe("python3", ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"]);
  const [major = 0, minor = 0] = (python ?? "0.0").split(".").map(Number);
  add("python", major === 3 && minor >= 9, python ? `Python ${python}` : "not found", "Install Python 3.9 or later; the Xcode command line tools include one.");
  const rustup = host.probe("rustup", ["--version"]);
  add("rustup", rustup !== null, rustup ?? "not found", "Install rustup, which fetches the pinned Rust toolchain for the physics modules: brew install rustup, or the installer at rustup.rs");
  return checks;
}

/** One manifest item with the license of its inventory row. */
export function manifestItem(inventory: unknown, inventoryId: string, item: { readonly id: string; readonly [detail: string]: unknown }): ManifestItem {
  const items: unknown = typeof inventory === "object" && inventory !== null ? Reflect.get(inventory, "items") : null;
  const rows: readonly unknown[] = Array.isArray(items) ? items : [];
  const row = rows.find(entry => typeof entry === "object" && entry !== null && Reflect.get(entry, "id") === inventoryId);
  const license: unknown = typeof row === "object" && row !== null ? Reflect.get(row, "license") : null;
  if (typeof license !== "string") throw new Error(`Inventory row ${inventoryId} is missing from config/offline-inventory.json`);
  return { ...item, inventoryId, license };
}

/** Validates an install manifest from `unknown`; every item with a path has a SHA-256 and a size. */
export function parseInstallManifest(input: unknown): InstallManifest {
  const items: unknown = typeof input === "object" && input !== null && Reflect.get(input, "schemaVersion") === 1 ? Reflect.get(input, "items") : null;
  if (!Array.isArray(items)) throw new Error("Invalid install manifest");
  const list: readonly unknown[] = items;
  const parsed = list.map((item): ManifestItem => {
    const get = (key: string): unknown => (typeof item === "object" && item !== null ? Reflect.get(item, key) : undefined);
    const id = get("id"), inventoryId = get("inventoryId"), license = get("license"), path = get("path"), sha256 = get("sha256"), bytes = get("bytes");
    if (typeof id !== "string" || typeof inventoryId !== "string" || typeof license !== "string" || license === "") throw new Error("Invalid install manifest item");
    if (path !== undefined && (typeof path !== "string" || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || typeof bytes !== "number" || !Number.isSafeInteger(bytes))) {
      throw new Error(`Install manifest item ${id} needs SHA-256 and size`);
    }
    return { ...(typeof item === "object" && item !== null ? item : {}), id, inventoryId, license };
  });
  return { ...(typeof input === "object" && input !== null ? input : {}), schemaVersion: 1, items: parsed };
}
