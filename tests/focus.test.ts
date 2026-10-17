import { expect, it } from "vitest";
import { withFocusReturn } from "../apps/web/src/ui/focus.ts";
it("returns permission focus on failure without stealing deliberate focus or focusing detached triggers", async () => {
  const body = {}, doc = { activeElement: body, body }; let focused = 0;
  const target = { isConnected: true, ownerDocument: doc, focus: () => { focused++; } };
  await expect(withFocusReturn(target, () => Promise.reject(new Error("denied")))).rejects.toThrow("denied");
  expect(focused).toBe(1);
  doc.activeElement = {};
  await withFocusReturn(target, () => Promise.resolve()); expect(focused).toBe(1);
  target.isConnected = false; doc.activeElement = body;
  await withFocusReturn(target, () => Promise.resolve()); expect(focused).toBe(1);
});
