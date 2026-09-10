import { expect, test } from "vite-plus/test";
import { createPlugin } from "../dist/index.mjs";
test("passes against its own injected host double", () => {
  const plugin = createPlugin({ getState: () => ({ resources: [10, 20] }) });
  expect(plugin.load()).toEqual({ resources: [10, 20] });
  expect(plugin.settings[0].key).toBe("port");
  plugin.unload();
});
