import type { CDPClient } from "./client.ts";
import { logger } from "../lib/logger.ts";

const log = logger("network");

export type CapturedResponse = {
  requestId: string;
  url: string;
  status: number;
  mimeType: string;
  body: string;
  json?: unknown;
};

type RequestInfo = {
  url: string;
  method: string;
  mimeType: string;
  status: number;
};

/**
 * Records JSON responses while the page runs. Mirrors the capture loop in the
 * original Python scripts but works through CDP events instead of polling logs.
 */
export class NetworkRecorder {
  private readonly requests = new Map<string, RequestInfo>();
  private readonly captured: CapturedResponse[] = [];
  private readonly unsubscribers: Array<() => void> = [];
  private readonly pending = new Set<Promise<void>>();
  private started = false;

  constructor(
    private readonly cdp: CDPClient,
    private readonly accept: (url: string) => boolean = () => true,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.cdp.send("Network.enable", {});

    this.unsubscribers.push(
      this.cdp.on("Network.requestWillBeSent", (params) => {
        const requestId = String(params.requestId ?? "");
        const request = (params.request ?? {}) as { url?: string; method?: string };
        if (!requestId || !request.url || !this.accept(request.url)) return;
        this.requests.set(requestId, {
          url: request.url,
          method: request.method ?? "GET",
          mimeType: "",
          status: 0,
        });
      }),
    );

    this.unsubscribers.push(
      this.cdp.on("Network.responseReceived", (params) => {
        const requestId = String(params.requestId ?? "");
        const info = this.requests.get(requestId);
        if (!info) return;
        const response = (params.response ?? {}) as { mimeType?: string; status?: number; url?: string };
        info.mimeType = response.mimeType ?? "";
        info.status = response.status ?? 0;
        if (response.url) info.url = response.url;
      }),
    );

    this.unsubscribers.push(
      this.cdp.on("Network.loadingFinished", (params) => {
        const requestId = String(params.requestId ?? "");
        const info = this.requests.get(requestId);
        if (!info) return;
        if (!info.mimeType.includes("json")) return;
        const task = this.readBody(requestId, info)
          .catch((error) => log.debug(`body read failed ${info.url}`, String(error)))
          .finally(() => this.pending.delete(task));
        this.pending.add(task);
      }),
    );

    this.unsubscribers.push(
      this.cdp.on("Network.loadingFailed", (params) => {
        this.requests.delete(String(params.requestId ?? ""));
      }),
    );
  }

  private async readBody(requestId: string, info: RequestInfo): Promise<void> {
    const result = (await this.cdp.send("Network.getResponseBody", { requestId }, 30_000)) as {
      body?: string;
      base64Encoded?: boolean;
    };
    let body = result.body ?? "";
    if (result.base64Encoded) {
      body = Buffer.from(body, "base64").toString("utf8");
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return;
    }
    this.captured.push({
      requestId,
      url: info.url,
      status: info.status,
      mimeType: info.mimeType,
      body,
      json,
    });
    log.debug(`captured ${info.status} ${info.url}`);
  }

  async drain(timeoutMs = 10_000): Promise<CapturedResponse[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size > 0 && Date.now() < deadline) {
      await Promise.all([...this.pending]);
    }
    return this.captured;
  }

  get responses(): CapturedResponse[] {
    return this.captured;
  }

  clear(): void {
    this.captured.length = 0;
    this.requests.clear();
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.started = false;
  }
}
