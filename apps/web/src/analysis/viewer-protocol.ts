// Host side of the UAVLogViewer message interface, protocol 1 (TASK-179, S14).
// The viewer half is third_party/uavlogviewer/patches/0002-message-interface.patch
// (src/mirage/bridge.js). Messages travel only between this page and the
// same-origin viewer frame; anything else is ignored before it is parsed here.

export const VIEWER_PROTOCOL = 1;
/** The viewer's own limit (bridge.js MAX_LOG_BYTES). */
export const MAX_VIEWER_LOG_BYTES = 512 * 1024 * 1024;
export const VIEWER_PATH = "/uavlogviewer/";

export type ViewerMessage =
  | { readonly type: "mirage.ready" }
  | { readonly type: "mirage.logAccepted"; readonly name: string; readonly bytes: number }
  | { readonly type: "mirage.logRejected"; readonly reason: string }
  | { readonly type: "mirage.logParsed"; readonly name: string; readonly messageTypes: number }
  | { readonly type: "mirage.eventsSet"; readonly count: number }
  | { readonly type: "mirage.secondLogParsed"; readonly name: string; readonly messageTypes: number }
  | { readonly type: "mirage.alignmentSet" };

export interface LoadLogMessage {
  readonly type: "mirage.loadLog";
  readonly protocol: typeof VIEWER_PROTOCOL;
  readonly name: string;
  readonly bytes: ArrayBuffer;
}

const field = (value: object, key: string): unknown => Reflect.get(value, key);
const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** A viewer message of protocol 1, or null for anything else. */
export function parseViewerMessage(data: unknown): ViewerMessage | null {
  if (typeof data !== "object" || data === null || field(data, "protocol") !== VIEWER_PROTOCOL) return null;
  const type = field(data, "type"), name = field(data, "name");
  switch (type) {
    case "mirage.ready":
      return { type };
    case "mirage.logAccepted": {
      const bytes = field(data, "bytes");
      return typeof name === "string" && count(bytes) ? { type, name, bytes } : null;
    }
    case "mirage.logRejected": {
      const reason = field(data, "reason");
      return typeof reason === "string" ? { type, reason } : null;
    }
    case "mirage.eventsSet": {
      const events = field(data, "count");
      return count(events) ? { type, count: events } : null;
    }
    case "mirage.alignmentSet":
      return { type };
    case "mirage.secondLogParsed": {
      const messageTypes = field(data, "messageTypes");
      return typeof name === "string" && count(messageTypes) ? { type, name, messageTypes } : null;
    }
    case "mirage.logParsed": {
      const messageTypes = field(data, "messageTypes");
      return typeof name === "string" && count(messageTypes) ? { type, name, messageTypes } : null;
    }
    default:
      return null;
  }
}

/** Why a file cannot be sent to the viewer as a DataFlash log, or null when it can. */
export function dataflashRefusal(name: string, bytes: ArrayLike<number>): string | null {
  if (bytes.length === 0) return `${name} is empty.`;
  if (bytes.length > MAX_VIEWER_LOG_BYTES) return `${name} is larger than the viewer's limit of ${MAX_VIEWER_LOG_BYTES / (1024 * 1024)} MiB.`;
  // DataFlash binary logs start with the 0xA3 0x95 message header.
  if (bytes[0] !== 0xa3 || bytes[1] !== 0x95) return `${name} is not a DataFlash binary log (it does not start with the 0xA3 0x95 header).`;
  return null;
}

/** The viewer's name rule: 1–255 characters, no path separators or control characters. */
export function viewerLogName(name: string): string {
  let cleaned = "";
  for (const char of name.replace(/[\\/]/g, "_")) cleaned += char.charCodeAt(0) < 0x20 ? "_" : char;
  return (cleaned.length === 0 ? "log.bin" : cleaned).slice(0, 255);
}

/** Events on the plot's timeline, which the viewer keeps for the next plot (TASK-180). */
export interface ViewerEvent { readonly timeMs: number; readonly text: string; readonly status: string }
export const setEventsMessage = (events: readonly ViewerEvent[]) => ({ type: "mirage.setEvents", protocol: VIEWER_PROTOCOL, events: events.slice(0, 2000) }) as const;

/** A second log to compare, its events and its alignment (TASK-181, patch 0004). */
export const loadSecondLogMessage = (name: string, bytes: ArrayBuffer) => ({ type: "mirage.loadSecondLog", protocol: VIEWER_PROTOCOL, name: viewerLogName(name), bytes }) as const;
export const setSecondEventsMessage = (events: readonly ViewerEvent[]) => ({ type: "mirage.setSecondEvents", protocol: VIEWER_PROTOCOL, events: events.slice(0, 2000) }) as const;
export const clearSecondLogMessage = () => ({ type: "mirage.clearSecondLog", protocol: VIEWER_PROTOCOL }) as const;
export const setAlignmentMessage = (alignment: unknown) => ({ type: "mirage.setAlignment", protocol: VIEWER_PROTOCOL, alignment }) as const;

export function loadLogMessage(name: string, bytes: ArrayBuffer): LoadLogMessage {
  return { type: "mirage.loadLog", protocol: VIEWER_PROTOCOL, name: viewerLogName(name), bytes };
}

export interface ViewerBuild {
  readonly commit: string;
  readonly patches: number;
  readonly files: number;
  readonly digest: string;
}

/** The parts of build-manifest.json the host shows, or null when it is not a TASK-179 manifest. */
export function parseViewerBuild(data: unknown): ViewerBuild | null {
  if (typeof data !== "object" || data === null || field(data, "schemaVersion") !== 1 || field(data, "task") !== "TASK-179") return null;
  const commit = field(data, "commit"), patches = field(data, "patches"), outputs = field(data, "outputs");
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit) || !Array.isArray(patches) || typeof outputs !== "object" || outputs === null) return null;
  const files = field(outputs, "files"), digest = field(outputs, "sha256");
  if (!count(files) || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return null;
  return { commit, patches: patches.length, files, digest };
}
