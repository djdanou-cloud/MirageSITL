import golden from "../fixtures/mavlink/golden.json" with { type: "json" };
import { expect, test } from "@playwright/test";
test("requests serial permission only on click, reports denial once, and never enables HITL", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let count = 0;
    Object.defineProperty(navigator, "serial", {
      value: {
        requestPort: () => {
          count++;
          document.documentElement.dataset.serialRequests = String(count);
          return Promise.reject(
            new DOMException("Serial permission denied", "NotAllowedError"),
          );
        },
      },
    });
  });
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("READY");
  await expect(
    page.getByRole("button", { name: "Connect serial", exact: true }),
  ).toBeEnabled();
  expect(
    await page.locator("html").getAttribute("data-serial-requests"),
  ).toBeNull();
  await page
    .getByRole("button", { name: "Connect serial", exact: true })
    .click();
  await expect(page.getByTestId("serial-status")).toContainText(
    "permission denied",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-serial-requests",
    "1",
  );
  await expect(page.getByTestId("worker-status")).toHaveText("READY");
});
test("missing Web Serial disables connection without prompting", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serial", { value: undefined });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Connect serial", exact: true }),
  ).toBeDisabled();
});
test("decodes fragmented serial bytes in the I/O Worker and releases streams on disconnect", async ({
  page,
}) => {
  const hex = golden.frames[2]!.hex;
  await page.addInitScript(
    ({ hex }) => {
      const bytes = Uint8Array.from(hex.match(/../g) ?? [], (b) =>
        parseInt(b, 16),
      );
      const port = {
        readable: null as ReadableStream<Uint8Array> | null,
        writable: null as WritableStream<Uint8Array> | null,
        open() {
          this.readable = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(bytes.slice(0, 9));
              c.enqueue(bytes.slice(9));
            },
          });
          this.writable = new WritableStream<Uint8Array>();
          return Promise.resolve();
        },
        close() {
          document.documentElement.dataset.portClosed = "true";
          return Promise.resolve();
        },
      };
      Object.defineProperty(navigator, "serial", {
        value: { requestPort: () => Promise.resolve(port) },
      });
    },
    { hex },
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Connect serial", exact: true })
    .click();
  await expect(page.getByTestId("serial-status")).toContainText(
    "received 1 MAVLink frames",
  );
  await expect(page.getByTestId("serial-status")).toContainText(
    "HITL unavailable",
  );
  await page
    .getByRole("button", { name: "Disconnect serial", exact: true })
    .click();
  await expect(page.getByTestId("serial-status")).toHaveText("Disconnected");
  await expect(page.locator("html")).toHaveAttribute(
    "data-port-closed",
    "true",
  );
});
