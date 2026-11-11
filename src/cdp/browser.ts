import { existsSync } from "node:fs";
import { config } from "../config.ts";
import { logger, sleep } from "../lib/logger.ts";

const log = logger("browser");

export type LaunchResult = {
  attached: boolean;
  spawned: boolean;
  binary: string;
  port: number;
  pid?: number;
};

export async function isCdpReachable(port = config.cdp.port, host = config.cdp.host, timeoutMs = 1_500): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const MAC_APP_BINARIES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

/** Resolve a binary name or absolute path to an executable path, or null. */
export function resolveBinary(binary: string | undefined): string | null {
  if (!binary) return null;
  if (binary.startsWith("/")) return existsSync(binary) ? binary : null;
  return Bun.which(binary);
}

export function findChromeBinary(): string {
  const configured = config.chrome.binary;
  const resolved = resolveBinary(configured);
  if (resolved) return resolved;
  const candidates = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "brave",
    "microsoft-edge",
    ...(process.platform === "darwin" ? MAC_APP_BINARIES : []),
  ];
  for (const candidate of candidates) {
    const path = resolveBinary(candidate);
    if (path) return path;
  }
  return configured;
}

/**
 * Attach to a Chrome that already exposes a CDP port, or launch a managed
 * Chrome with a persistent profile so the Scopus login is reused.
 *
 * Chrome only opens a debugging port when it owns the user-data-dir. If a
 * normal Chrome is already running with the same profile, close it first or
 * point CHROME_USER_DATA_DIR at a dedicated directory.
 */
export async function ensureBrowser(options?: { launch?: boolean; headless?: boolean }): Promise<LaunchResult> {
  const port = config.cdp.port;
  if (await isCdpReachable(port)) {
    log.info(`attached to existing Chrome on port ${port}`);
    return { attached: true, spawned: false, binary: findChromeBinary(), port };
  }

  if (options?.launch === false) {
    throw new Error(
      `no Chrome CDP endpoint on port ${port}. Start Chrome with --remote-debugging-port=${port} or run "bun run browser".`,
    );
  }

  const binary = findChromeBinary();
  if (!resolveBinary(binary)) {
    throw new Error(`Chrome binary not found: ${binary}. Set CHROME_BIN.`);
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${config.chrome.userDataDir}`,
    `--profile-directory=${config.chrome.profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${config.chrome.windowSize}`,
  ];
  if (options?.headless) args.push("--headless=new");

  log.info(`launching ${binary} with profile ${config.chrome.profileDirectory}`);
  const child = Bun.spawn([binary, ...args], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await isCdpReachable(port)) {
      log.info(`Chrome debugger ready on port ${port} pid=${child.pid}`);
      return { attached: false, spawned: true, binary, port, pid: child.pid };
    }
    await sleep(300);
  }

  throw new Error(
    `Chrome did not open port ${port}. A running Chrome may already own ${config.chrome.userDataDir}. ` +
      `Close it, or set CHROME_USER_DATA_DIR to a dedicated profile directory.`,
  );
}

export async function closeBrowser(): Promise<void> {
  if (!(await isCdpReachable())) return;
  const { CDPClient } = await import("./client.ts");
  const cdp = await CDPClient.connect({ port: config.cdp.port, host: config.cdp.host, timeoutMs: 10_000 });
  try {
    await cdp.send("Browser.close", {}, 5_000);
  } catch {
    // Chrome often drops the socket before acknowledging Browser.close.
  } finally {
    cdp.close();
  }
}

export async function browserStatus(): Promise<{
  reachable: boolean;
  binary: string;
  profile: string;
  version?: Record<string, unknown>;
  targets?: Array<{ type: string; url: string; title?: string }>;
}> {
  const binary = findChromeBinary();
  const reachable = await isCdpReachable();
  if (!reachable) {
    return { reachable, binary, profile: config.chrome.userDataDir };
  }
  const version = (await fetch(`http://${config.cdp.host}:${config.cdp.port}/json/version`).then((r) => r.json())) as Record<string, unknown>;
  const targets = (await fetch(`http://${config.cdp.host}:${config.cdp.port}/json`).then((r) => r.json())) as Array<{
    type: string;
    url: string;
    title?: string;
  }>;
  return {
    reachable,
    binary,
    profile: config.chrome.userDataDir,
    version,
    targets: targets.map(({ type, url, title }) => ({ type, url, title })),
  };
}
