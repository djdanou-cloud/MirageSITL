/** Instructor shortcuts never act while typing, composing or using modifier shortcuts. */
export function instructorKey(
  event: KeyboardEvent,
): "pause" | "reset" | "fault" | null {
  const target = event.target;
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    (target instanceof Element &&
      target.closest(
        "input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox']",
      ))
  )
    return null;
  if (event.code === "KeyP") return "pause";
  if (event.code === "KeyR") return "reset";
  if (event.code === "KeyF") return "fault";
  return null;
}
