/** `?g3=1` selects the TASK-073 production measurement scene. The demo stays unchanged. */
/**
 * What the measurement scene shows full-screen: the external chase camera with
 * the whole drone (default, used by tests and captures) or the mounted FPV
 * image (`?view=fpv`). Both always render; only the presented image changes.
 */
export type G3View = "chase" | "fpv";
export function g3ViewFromSearch(search: string): G3View {
  return new URLSearchParams(search).get("view") === "fpv" ? "fpv" : "chase";
}

export function g3Requested(search: string): boolean {
  return new URLSearchParams(search).get("g3") === "1";
}
