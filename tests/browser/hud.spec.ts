import { encodeInto } from "@mirage/mavlink/codec";
import { expect, test, type Page } from "@playwright/test";
import golden from "../fixtures/mavlink/ekf-golden.json" with { type: "json" };

async function pushSerial(page: Page, frames: number[][]): Promise<void> {
  await page.evaluate((batches) => {
    function read(host: object): unknown {
      if (!("__pushSerial" in host)) return undefined;
      return host.__pushSerial;
    }
    function isPush(value: unknown): value is (values: number[]) => void {
      return typeof value === "function";
    }
    const push = read(window);
    if (!isPush(push)) throw new Error("Serial injector is missing");
    for (const frame of batches) push(frame);
  }, frames);
}
function goldenFrame(index: number): number[] {
  const hex = golden.frames[index]?.hex;
  if (!hex) throw new Error(`Missing EKF golden frame ${index}`);
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2)
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

/** CRC-valid EKF_STATUS_REPORT derived from the pinned golden payload. */
function ekfFrame(flags: number): number[] {
  const raw = Uint8Array.from(goldenFrame(1));
  const length = raw[1];
  if (length === undefined || raw.length < 10 + length)
    throw new Error("Golden EKF frame is truncated");
  const payload = new Uint8Array(26);
  payload.set(raw.subarray(10, 10 + length));
  payload[20] = flags & 255;
  payload[21] = (flags >>> 8) & 255;
  const sequence = raw[4];
  const systemId = raw[5];
  const componentId = raw[6];
  if (
    sequence === undefined ||
    systemId === undefined ||
    componentId === undefined
  )
    throw new Error("Golden EKF header is incomplete");
  const out = new Uint8Array(40);
  const count = encodeInto(193, payload, sequence, systemId, componentId, out);
  if (count === 0) throw new Error("EKF frame encode failed");
  return [...out.subarray(0, count)];
}
test("HUD labels demo/EKF provenance while physics ticks advance", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("hud-ap-status")).toContainText("EKF UNKNOWN");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect
    .poll(async () =>
      Number((await page.getByTestId("tick").innerText()).split(" ")[0]),
    )
    .toBeGreaterThan(20);
  await expect(page.getByRole("img", { name: /Roll.*pitch/ })).toBeVisible();
  await expect(page.getByTestId("hud-ap-status")).toContainText(
    "ArduPilot disconnected",
  );
});
test("live serial EKF diagnostics drive fresh, degraded, stale, and disconnected HUD states", async ({
  page,
}) => {
  const heartbeat = goldenFrame(0);
  const degraded = ekfFrame(167);
  const valid = ekfFrame(55);
  await page.addInitScript(() => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const port = {
      readable: new ReadableStream<Uint8Array>({
        start(stream) {
          controller = stream;
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          const count =
            Number(document.documentElement.dataset.serialWrites ?? "0") + 1;
          document.documentElement.dataset.serialWrites = String(count);
          document.documentElement.dataset.serialWriteBytes = String(
            chunk.byteLength,
          );
        },
      }),
      open() {
        return Promise.resolve();
      },
      close() {
        document.documentElement.dataset.portClosed = "true";
        return Promise.resolve();
      },
    };
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: { requestPort: () => Promise.resolve(port) },
    });
    Object.assign(window, {
      __pushSerial(values: number[]) {
        if (!controller) throw new Error("Serial reader is not open");
        controller.enqueue(Uint8Array.from(values));
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("hud-ap-status")).toContainText(
    "DEMO TRUTH · ArduPilot disconnected · EKF UNKNOWN",
  );
  await page
    .getByRole("button", { name: "Connect serial", exact: true })
    .click();
  await expect(page.getByTestId("serial-status")).toContainText(
    "Transport connected",
  );
  await pushSerial(page, [heartbeat]);
  await expect
    .poll(async () =>
      Number(
        (await page.locator("html").getAttribute("data-serial-writes")) ?? "0",
      ),
    )
    .toBeGreaterThan(0);
  await expect(page.locator("html")).toHaveAttribute(
    "data-serial-write-bytes",
    "45",
  );
  await pushSerial(page, [heartbeat, degraded]);
  await expect(page.getByTestId("hud-ap-status")).toContainText("AP MODE 5");
  await expect(page.getByTestId("hud-ap-status")).toContainText("FRESH");
  await expect(page.getByText("EKF DEGRADED", { exact: true })).toBeVisible();
  await pushSerial(page, [heartbeat, valid]);
  await expect(page.getByText("EKF flags valid", { exact: true })).toBeVisible();
  const mutations = await page.evaluate(async (frames) => {
    function read(host: object): unknown {
      if (!("__pushSerial" in host)) return undefined;
      return host.__pushSerial;
    }
    function isPush(value: unknown): value is (values: number[]) => void {
      return typeof value === "function";
    }
    const status = document.querySelector("[data-testid='hud-ap-status']");
    if (!status) throw new Error("HUD status is missing");
    let count = 0;
    const observer = new MutationObserver((records) => {
      count += records.length;
    });
    observer.observe(status, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    const push = read(window);
    if (!isPush(push)) throw new Error("Serial injector is missing");
    const timer = window.setInterval(() => {
      for (const frame of frames) push(frame);
    }, 50);
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    window.clearInterval(timer);
    observer.disconnect();
    return count;
  }, [heartbeat, valid]);
  expect(mutations).toBeLessThanOrEqual(12);
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("hud-ap-status")).toContainText("STALE");
  await expect(page.getByText("EKF STALE", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Disconnect serial", exact: true })
    .click();
  await expect(page.getByTestId("hud-ap-status")).toContainText(
    "DEMO TRUTH · ArduPilot disconnected · EKF UNKNOWN",
  );
});
