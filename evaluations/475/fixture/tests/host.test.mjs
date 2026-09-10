import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, expect, test, vi } from "vite-plus/test";

const token = "qualification-token-not-a-real-credential-0001";
const values = { plugin: { Server: { enabled: true, token } } };
const readPath = (object, path) =>
  path ? path.split(".").reduce((value, key) => value?.[key], object) : object;
const config = Object.assign(new EventEmitter(), {
  get(path, fallback) {
    return readPath(values, path) ?? fallback;
  },
  set(path, value) {
    if (readPath(values, path) === value) return;
    const keys = path.split(".");
    const last = keys.pop();
    const parent = keys.reduce((node, key) => (node[key] ??= {}), values);
    parent[last] = value;
    this.emit("config.set", path, value);
  },
});
const state = { info: { resources: [10, 20, 30], secret: "must-not-leak" } };
vi.stubGlobal("window", { config, getStore: (path) => readPath(state, path) });
vi.stubGlobal("config", config);
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const resolved = createRequire(import.meta.url).resolve("..");
const entry = await import(pathToFileURL(resolved).href);
const auth = (credential = config.get("plugin.Server.token")) => ({
  Authorization: `Bearer ${credential}`,
});
let currentPort;

async function freePort() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
async function request(port, options = {}, host = "127.0.0.1", suffix = "") {
  return fetch(`http://${host}:${port}/api/v1/snapshot${suffix}`, {
    ...options,
    signal: AbortSignal.timeout(1000),
  });
}
async function status(port, options, host) {
  try {
    return (await request(port, options, host)).status;
  } catch {
    return 0;
  }
}
function untrustedHostStatus(port) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/v1/snapshot",
        headers: { ...auth(), Host: "untrusted.invalid" },
        signal: AbortSignal.timeout(1000),
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.end();
  });
}
afterAll(async () => {
  entry.pluginWillUnload?.();
  if (currentPort)
    await vi.waitFor(async () => expect(await status(currentPort)).toBe(0), { timeout: 5000 });
  vi.unstubAllGlobals();
});

test("uses the host-resolved built entry and actual plugin/settings surface", () => {
  expect(pkg.name).toBe("poi-plugin-server");
  expect(pkg.poiPlugin).toMatchObject({ id: "Server", name: "Server" });
  expect(entry.pluginDidLoad).toBeTypeOf("function");
  expect(entry.pluginWillUnload).toBeTypeOf("function");
  expect(entry.settingsClass).toBeTypeOf("function");
  const html = renderToStaticMarkup(React.createElement(entry.settingsClass));
  for (const label of ["Enabled", "Port", "LAN", "token"]) expect(html).toContain(label);
});

test("real configuration events apply auth, port, LAN and enabled changes without reload", async () => {
  expect(entry.pluginDidLoad).toBeTypeOf("function");
  currentPort = await freePort();
  config.set("plugin.Server.port", currentPort);
  entry.pluginDidLoad(); // The actual host does not await its lifecycle hooks.
  await expect.poll(() => status(currentPort, { headers: auth() }), { timeout: 5000 }).toBe(200);
  const first = await request(currentPort, { headers: auth() });
  expect(await first.json()).toEqual({ resources: [10, 20, 30] });
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(await status(currentPort)).toBe(401);
  expect(await status(currentPort, { headers: auth("incorrect") })).toBe(401);
  expect((await request(currentPort, {}, "127.0.0.1", `?token=${token}`)).status).not.toBe(200);
  expect(await untrustedHostStatus(currentPort)).toBe(403);
  expect(
    await status(currentPort, { headers: { ...auth(), Origin: "https://untrusted.invalid" } }),
  ).toBe(403);
  expect(
    await status(currentPort, { headers: { ...auth(), "X-Forwarded-Host": "trusted.example" } }),
  ).toBe(403);
  expect(await status(currentPort, { method: "POST", headers: auth() })).toBe(405);
  config.set("plugin.Server.token", "replacement-qualification-token-long-enough-0002");
  await expect.poll(() => status(currentPort, { headers: auth() }), { timeout: 5000 }).toBe(200);
  expect(await status(currentPort, { headers: auth(token) })).toBe(401);
  const oldPort = currentPort;
  currentPort = await freePort();
  config.set("plugin.Server.port", currentPort);
  await expect.poll(() => status(currentPort, { headers: auth() }), { timeout: 5000 }).toBe(200);
  await expect.poll(() => status(oldPort), { timeout: 5000 }).toBe(0);
  const lanAddress = Object.values(networkInterfaces())
    .flat()
    .find((address) => address?.family === "IPv4" && !address.internal)?.address;
  expect(
    lanAddress,
    "this LAN qualification needs a reachable non-loopback IPv4 interface",
  ).toBeTruthy();
  expect(await status(currentPort, { headers: auth() }, lanAddress)).toBe(0);
  config.set("plugin.Server.lan", true);
  await expect
    .poll(() => status(currentPort, { headers: auth() }, lanAddress), { timeout: 5000 })
    .toBe(200);
  expect(await status(currentPort, {}, lanAddress)).toBe(401);
  config.set("plugin.Server.enabled", false);
  await expect.poll(() => status(currentPort), { timeout: 5000 }).toBe(0);
  config.set("plugin.Server.enabled", true);
  await expect.poll(() => status(currentPort, { headers: auth() }), { timeout: 5000 }).toBe(200);
  entry.pluginWillUnload();
  await expect.poll(() => status(currentPort), { timeout: 5000 }).toBe(0);
  expect(config.listenerCount("config.set")).toBe(0);
}, 30000);
