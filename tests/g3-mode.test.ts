import { describe, expect, it } from "vitest";
import { g3Requested, g3ViewFromSearch } from "../apps/web/src/render/g3-mode";

// TASK-073: the measurement scene presents the chase view unless `view=fpv` is requested.
describe("g3 view selection", () => {
  it("defaults to the chase view", () => {
    expect(g3ViewFromSearch("?g3=1")).toBe("chase");
    expect(g3ViewFromSearch("?g3=1&view=chase")).toBe("chase");
    expect(g3ViewFromSearch("?g3=1&view=FPV")).toBe("chase");
  });
  it("presents the FPV image only when asked", () => {
    expect(g3ViewFromSearch("?g3=1&view=fpv")).toBe("fpv");
    expect(g3Requested("?view=fpv")).toBe(false);
  });
});
