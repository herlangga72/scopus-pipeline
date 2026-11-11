import { logger } from "../lib/logger.ts";

const log = logger("cdp");

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

export class CDPError extends Error {}

/**
 * Minimal Chrome DevTools Protocol client built on Bun's WebSocket.
 * One instance talks to one page target.
 */
export class CDPClient {
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private nextId = 1;
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => this.onMessage(String(event.data)));
    ws.addEventListener("close", () => this.onClose());
    ws.addEventListener("error", () => this.onClose());
  }

  static async connect(options: { port: number; host?: string; timeoutMs?: number; targetUrlIncludes?: string }): Promise<CDPClient> {
    const host = options.host ?? "127.0.0.1";
    const timeoutMs = options.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const targets = (await fetch(`http://${host}:${options.port}/json`).then((r) => r.json())) as Array<{
          type: string;
          url: string;
          webSocketDebuggerUrl?: string;
        }>;
        const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
        const target = (options.targetUrlIncludes ? pages.find((page) => page.url.includes(options.targetUrlIncludes!)) : undefined) ?? pages[0];
        if (!target?.webSocketDebuggerUrl) {
          throw new Error(`no page target with a debugger URL on ${host}:${options.port}`);
        }
        const socketUrl = target.webSocketDebuggerUrl.replace("localhost", host);
        return await CDPClient.open(socketUrl, timeoutMs);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new CDPError(`cannot attach to Chrome at ${host}:${options.port}: ${String(lastError)}`);
  }

  private static open(url: string, timeoutMs: number): Promise<CDPClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new CDPError(`timed out opening CDP websocket ${url}`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        log.debug(`connected ${url}`);
        resolve(new CDPClient(ws));
      });
      ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new CDPError(`CDP websocket error: ${String(event)}`));
      });
    });
  }

  private onMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new CDPError(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const method = message.method;
    if (typeof method !== "string") return;
    const handlers = this.handlers.get(method);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler((message.params as Record<string, unknown>) ?? {}, message.sessionId as string | undefined);
      } catch (error) {
        log.warn(`handler for ${method} threw`, String(error));
      }
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CDPError("CDP connection closed"));
    }
    this.pending.clear();
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new CDPError("CDP connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CDPError(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: EventHandler): () => void {
    let handlers = this.handlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers?.delete(handler);
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

export async function attach(options?: { port?: number; host?: string; targetUrlIncludes?: string }): Promise<CDPClient> {
  const { config } = await import("../config.ts");
  return CDPClient.connect({
    port: options?.port ?? config.cdp.port,
    host: options?.host ?? config.cdp.host,
    timeoutMs: config.cdp.timeoutMs,
    targetUrlIncludes: options?.targetUrlIncludes,
  });
}
