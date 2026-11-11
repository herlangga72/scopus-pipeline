const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[(Bun.env.LOG_LEVEL as LogLevel) in LEVELS ? (Bun.env.LOG_LEVEL as LogLevel) : "info"];

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const suffix = extra === undefined ? "" : ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logger(scope: string) {
  return {
    debug: (message: string, extra?: unknown) => emit("debug", scope, message, extra),
    info: (message: string, extra?: unknown) => emit("info", scope, message, extra),
    warn: (message: string, extra?: unknown) => emit("warn", scope, message, extra),
    error: (message: string, extra?: unknown) => emit("error", scope, message, extra),
  };
}

export type Logger = ReturnType<typeof logger>;

export class Progress {
  private done = 0;
  private ok = 0;
  private failed = 0;
  constructor(
    private readonly total: number,
    private readonly label: string,
    private readonly log: Logger,
  ) {}

  tick(success: boolean, detail?: string): void {
    this.done += 1;
    if (success) this.ok += 1;
    else this.failed += 1;
    const pct = this.total === 0 ? 100 : Math.round((this.done / this.total) * 100);
    this.log.info(`${this.label} ${this.done}/${this.total} (${pct}%) ok=${this.ok} failed=${this.failed}${detail ? ` ${detail}` : ""}`);
  }

  summary(): { done: number; ok: number; failed: number } {
    return { done: this.done, ok: this.ok, failed: this.failed };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
