import { config } from "../config.ts";
import { ensureBrowser } from "../cdp/browser.ts";
import { attach } from "../cdp/client.ts";
import { Page } from "../cdp/page.ts";
import { ensureDir } from "../lib/fsx.ts";
import { logger } from "../lib/logger.ts";

const log = logger("login");

const DEFAULT_LOGIN_URL =
  "https://www.scopus.com/pages/signIn?referralUrl=https%3A%2F%2Fwww.scopus.com%2Fpages%2Fhome";

export async function runLogin(options?: { url?: string; headless?: boolean }): Promise<void> {
  await ensureDir(config.chrome.userDataDir);

  const result = await ensureBrowser({ headless: options?.headless });
  log.info(result.attached ? `using browser on port ${result.port}` : `launched browser pid=${result.pid} port=${result.port}`);
  log.info(`profile: ${config.chrome.userDataDir}`);

  const cdp = await attach();
  const page = new Page(cdp);
  const url = options?.url ?? DEFAULT_LOGIN_URL;
  try {
    try {
      await page.navigate(url, 60_000);
    } catch {
      log.warn(`page did not finish loading, it may still be redirecting: ${await page.url().catch(() => url)}`);
    }
    log.info(`opened ${await page.url().catch(() => url)}`);
    log.info("sign in to Scopus in that window, then verify with: bun run doctor --deep");
  } finally {
    page.close();
  }
}
