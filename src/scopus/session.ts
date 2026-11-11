import { attach } from "../cdp/client.ts";
import { Page } from "../cdp/page.ts";
import { ensureBrowser } from "../cdp/browser.ts";

export async function withPage<T>(run: (page: Page) => Promise<T>, options?: { launch?: boolean; headless?: boolean }): Promise<T> {
  await ensureBrowser({ launch: options?.launch, headless: options?.headless });
  const cdp = await attach();
  const page = new Page(cdp);
  try {
    return await run(page);
  } finally {
    page.close();
  }
}
