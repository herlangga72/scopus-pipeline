import type { CDPClient } from "./client.ts";
import { sleep } from "../lib/logger.ts";

export class Page {
  constructor(public readonly cdp: CDPClient) {}

  async evaluate<T>(expression: string, options?: { awaitPromise?: boolean; timeoutMs?: number }): Promise<T> {
    const result = (await this.cdp.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: options?.awaitPromise ?? true,
        returnByValue: true,
        userGesture: true,
      },
      options?.timeoutMs ?? 130_000,
    )) as {
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };

    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown evaluate error";
      throw new Error(`page.evaluate failed: ${detail}`);
    }
    return result.result?.value as T;
  }

  async url(): Promise<string> {
    return this.evaluate<string>("location.href");
  }

  async title(): Promise<string> {
    return this.evaluate<string>("document.title");
  }

  async navigate(url: string, timeoutMs = 60_000): Promise<void> {
    await this.cdp.send("Page.enable", {});
    await this.cdp.send("Page.navigate", { url }, timeoutMs);
    await this.waitFor("document.readyState === 'complete'", timeoutMs);
  }

  async waitFor(expression: string, timeoutMs = 30_000, intervalMs = 250): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate<boolean>(`Boolean(${expression})`, { timeoutMs: 10_000 })) return;
      } catch {
        // Page may be navigating. Keep polling.
      }
      await sleep(intervalMs);
    }
    throw new Error(`timeout waiting for: ${expression}`);
  }

  async waitForNetworkIdle(idleMs = 750, timeoutMs = 30_000): Promise<void> {
    await this.evaluate(
      `(() => new Promise((resolve) => {
        let timer = setTimeout(done, ${idleMs});
        const observer = new PerformanceObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(done, ${idleMs});
        });
        try { observer.observe({ type: 'resource', buffered: true }); } catch {}
        function done() { try { observer.disconnect(); } catch {} resolve(true); }
        setTimeout(done, ${timeoutMs});
      }))()`,
      { timeoutMs: timeoutMs + 5_000 },
    );
  }

  close(): void {
    this.cdp.close();
  }
}
