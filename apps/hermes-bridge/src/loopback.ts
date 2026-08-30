import { isIP } from "node:net";

const loopbackUrlMessage = "Usine server URL must be a loopback HTTP(S) URL";

export function assertLoopbackHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(loopbackUrlMessage);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    !isLoopbackHostname(url.hostname)
  ) {
    throw new Error(loopbackUrlMessage);
  }
  return url;
}

export function assertLoopbackHost(host: string): void {
  if (!isLoopbackHostname(host)) throw new Error("Hermes MCP host must be loopback");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}
