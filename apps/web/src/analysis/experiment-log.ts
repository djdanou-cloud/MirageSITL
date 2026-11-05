import { reopenRecording } from "@mirage/aar/recorder-v2-host";
import type { ExperimentPayload } from "@mirage/aircraft/experiment";
import type { StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";
import { readParameterLog, type ParameterChange } from "../params/parameter-sets";
import type { LauncherFiles } from "../run/session-link";
import { experimentContext, recordingDataflash, viewerEvents, type AnalysisContext } from "./experiment-adapter";
import type { ViewerRequest } from "./LogViewerHost";

// A stored experiment's log and context (TASK-180): the run's own DataFlash log while the launcher has it, and otherwise one written from its stored recording, with a note that
// says which. Its parameter history is the run's own if one was stored; none is ever made up.

export interface Listed { readonly stored: StoredVersion; readonly payload: ExperimentPayload }
const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

export async function findExperimentLog(store: ProjectStore, projectId: string, launcher: LauncherFiles | null, item: Listed): Promise<{ readonly request: ViewerRequest | null; readonly context: AnalysisContext; readonly note: string }> {
  const logs = await store.listItems(projectId, "parameter-log");
  const own = logs.map(readParameterLog).filter(log => log.experimentSha256 === item.stored.sha256).at(-1);
  const changes: readonly ParameterChange[] | null = own ? own.changes : null;
  const shown = experimentContext(item.stored.record.name, item.payload, changes), events = viewerEvents(shown);
  const { sitl, recording, session } = item.payload;
  if (sitl.ownership === "launcher" && launcher) {
    try {
      const files = await launcher.logs(sitl.experimentId), name = (files.attachments ?? files.dataflash).at(-1);
      if (name) {
        const bytes = await launcher.dataflash(sitl.experimentId, name);
        return { request: { id: `${item.stored.sha256}:${name}`, name, bytes: toBuffer(bytes), events }, context: shown, note: `ArduPilot's own log of this run, ${name}, from the launcher.` };
      }
    } catch {
      // The launcher may be gone or no longer hold it: the recording is next.
    }
  }
  if (recording) {
    const opened = await reopenRecording(recording.recordId).catch(() => null);
    const bytes = opened ? recordingDataflash(opened.rows, session.home, changes) : null;
    if (bytes) {
      return { request: { id: `${item.stored.sha256}:recording`, name: `${item.stored.record.name}.bin`, bytes: toBuffer(bytes), events }, context: shown,
        note: `MirageSITL's truth from the stored recording, with no ArduPilot data: ${launcher ? "the launcher has no log of this run" : "enter the launcher's token on the Run tab for ArduPilot's own log"}.` };
    }
  }
  return { request: null, context: shown, note: "No log of this run is at hand: neither the launcher nor a stored recording has one." };
}
