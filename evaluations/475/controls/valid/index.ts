import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createElement } from "react";

type ConfigListener = (path: string, value: unknown) => void;
interface HostConfig {
  get(path: string, fallback?: unknown): unknown;
  set(path: string, value: unknown): void;
  on(event: "config.set", listener: ConfigListener): void;
  removeListener(event: "config.set", listener: ConfigListener): void;
}
declare const window: { config: HostConfig; getStore(path?: string): unknown };
const namespace = "plugin.Server.";
const config = window.config;
let loaded = false;
let server: Server | undefined;
let pending = Promise.resolve();

function token(): string {
  const value = config.get(`${namespace}token`);
  if (typeof value === "string" && value.length >= 32) return value;
  const generated = randomBytes(32).toString("hex");
  config.set(`${namespace}token`, generated);
  return generated;
}

function validCredential(header: string | undefined): boolean {
  const expected = Buffer.from(`Bearer ${token()}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function restart(): Promise<void> {
  if (server) {
    const previous = server;
    server = undefined;
    previous.closeAllConnections();
    await new Promise<void>((resolve) => previous.close(() => resolve()));
  }
  if (!loaded || config.get(`${namespace}enabled`, false) !== true) return;
  const configuredPort = config.get(`${namespace}port`, 18765);
  if (
    typeof configuredPort !== "number" ||
    !Number.isInteger(configuredPort) ||
    configuredPort < 1 ||
    configuredPort > 65535
  )
    throw new Error("invalid listener port");
  token();
  const lan = config.get(`${namespace}lan`, false) === true;
  const listener = createServer((request, response) => {
    const deny = (status: number): void => {
      response.writeHead(status).end();
    };
    const expectedHost = `127.0.0.1:${configuredPort}`;
    const host = request.headers.host;
    const localAddress = request.socket.localAddress?.replace(/^::ffff:/, "");
    const allowedHost =
      host === expectedHost ||
      host === `localhost:${configuredPort}` ||
      (lan && host === `${localAddress}:${configuredPort}`);
    if (!allowedHost) return deny(403);
    if (request.headers.origin && request.headers.origin !== `http://${host}`) return deny(403);
    if (request.headers.forwarded || request.headers["x-forwarded-host"]) return deny(403);
    const url = new URL(request.url ?? "/", `http://${expectedHost}`);
    if (url.search !== "") return deny(400);
    if (!validCredential(request.headers.authorization)) return deny(401);
    if (request.method !== "GET") return deny(405);
    if (url.pathname !== "/api/v1/snapshot") return deny(404);
    const state = window.getStore("info.resources");
    const resources = Array.isArray(state)
      ? state.filter((value): value is number => typeof value === "number").slice(0, 8)
      : [];
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ resources }));
  });
  server = listener;
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(configuredPort, lan ? "0.0.0.0" : "127.0.0.1", () => {
      listener.off("error", reject);
      resolve();
    });
  });
}

function schedule(): void {
  pending = pending.then(restart).catch(() => {
    console.error("Plugin listener could not apply its configuration.");
  });
}
const changed: ConfigListener = (path) => {
  if (path.startsWith(namespace)) schedule();
};

export function pluginDidLoad(): void {
  if (loaded) return;
  loaded = true;
  config.on("config.set", changed);
  schedule();
}

export function pluginWillUnload(): void {
  loaded = false;
  config.removeListener("config.set", changed);
  schedule();
}

export function settingsClass() {
  return createElement(
    "fieldset",
    null,
    createElement("legend", null, "Server"),
    createElement(
      "label",
      null,
      "Enabled",
      createElement("input", {
        type: "checkbox",
        defaultChecked: config.get(`${namespace}enabled`, false) === true,
        onChange: (event: { currentTarget: { checked: boolean } }) =>
          config.set(`${namespace}enabled`, event.currentTarget.checked),
      }),
    ),
    createElement(
      "label",
      null,
      "Port",
      createElement("input", {
        type: "number",
        defaultValue: String(config.get(`${namespace}port`, 18765)),
        onChange: (event: { currentTarget: { value: string } }) =>
          config.set(`${namespace}port`, Number(event.currentTarget.value)),
      }),
    ),
    createElement(
      "label",
      null,
      "Allow LAN",
      createElement("input", {
        type: "checkbox",
        defaultChecked: config.get(`${namespace}lan`, false) === true,
        onChange: (event: { currentTarget: { checked: boolean } }) =>
          config.set(`${namespace}lan`, event.currentTarget.checked),
      }),
    ),
    createElement(
      "label",
      null,
      "Bearer token",
      createElement("input", {
        type: "password",
        readOnly: true,
        value: token(),
      }),
    ),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => config.set(`${namespace}token`, randomBytes(32).toString("hex")),
      },
      "Rotate token",
    ),
  );
}
