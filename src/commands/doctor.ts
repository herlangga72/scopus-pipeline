import { stat } from "node:fs/promises";
import { config } from "../config.ts";
import { findChromeBinary, isCdpReachable } from "../cdp/browser.ts";
import { attach } from "../cdp/client.ts";
import { Page } from "../cdp/page.ts";
import { logger } from "../lib/logger.ts";
import { graphql } from "../scopus/authors.ts";

const log = logger("doctor");

type CheckStatus = "ok" | "warn" | "fail";
type Check = { name: string; status: CheckStatus; detail: string };

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(options?: { deep?: boolean }): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });

  add("bun", "ok", `${Bun.version} (${process.platform}/${process.arch})`);
  add("project", "ok", config.root);

  const binary = findChromeBinary();
  const binaryPath = Bun.which(binary);
  add("chrome", binaryPath ? "ok" : "fail", binaryPath ?? `${binary} not found, set CHROME_BIN`);

  const profileExists = await pathExists(config.chrome.userDataDir);
  add("chrome profile", profileExists ? "ok" : "warn", config.chrome.userDataDir);

  const reachable = await isCdpReachable();
  add("cdp", reachable ? "ok" : "warn", reachable ? `http://${config.cdp.host}:${config.cdp.port}` : "not running, run: bun run browser");

  const seedExists = await pathExists(config.paths.seedAuthorIds);
  add("seed ids", seedExists ? "ok" : "warn", config.paths.seedAuthorIds);

  if (reachable) {
    const cdp = await attach();
    const page = new Page(cdp);
    try {
      const url = await page.url();
      const onScopus = url.startsWith("https://www.scopus.com");
      add("page", onScopus ? "ok" : "warn", url);

      if (options?.deep) {
        try {
          await graphql(page, '{ author(id: "0") { id } }');
          add("scopus auth", "ok", "session authorized");
        } catch (error) {
          add("scopus auth", "fail", String(error));
        }
      }
    } finally {
      page.close();
    }
  }

  const width = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) {
    const mark = check.status === "ok" ? "OK  " : check.status === "warn" ? "WARN" : "FAIL";
    log.info(`${mark} ${check.name.padEnd(width)}  ${check.detail}`);
  }

  if (checks.some((check) => check.status === "fail")) {
    process.exitCode = 1;
  }
  return checks;
}
