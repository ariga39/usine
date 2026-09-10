import { expect, test, vi } from "vite-plus/test";
vi.stubGlobal("window", { config: { get() {}, set() {} } });
const entry = await import("../dist/index.mjs");
test("declares its own lifecycle", () => {
  expect(typeof entry.pluginDidLoad).toBe("function");
  expect(typeof entry.pluginWillUnload).toBe("function");
});
