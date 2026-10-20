/** `?g3=1` selects the TASK-073 production measurement scene. The demo stays unchanged. */
export function g3Requested(search: string): boolean {
  return new URLSearchParams(search).get("g3") === "1";
}
