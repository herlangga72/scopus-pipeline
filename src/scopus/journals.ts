import { config } from "../config.ts";
import type { Page } from "../cdp/page.ts";
import { ensureScopusPage, ScopusAuthError } from "./authors.ts";
import type { ScopusCiteScore, ScopusJournalMetrics, JournalRecord } from "./types.ts";

type FetchResult = { status: number; text: string };

export async function fetchJournalRecord(page: Page, sourceId: string): Promise<JournalRecord> {
  await ensureScopusPage(page);
  const base = `/gateway/sources/sources/${encodeURIComponent(sourceId)}`;
  const result = await page.evaluate<{ metrics: FetchResult; citescore: FetchResult }>(
    `(async () => {
      const read = async (url) => {
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        return { status: response.status, text: await response.text() };
      };
      const metricsUrl = '${base}/metrics';
      const citescoreUrl = '${base}/citescore';
      const [metrics, citescore] = await Promise.all([read(metricsUrl), read(citescoreUrl)]);
      return { metrics, citescore };
    })()`,
  );

  for (const part of [result.metrics, result.citescore]) {
    if (part.status === 401 || part.status === 403) {
      throw new ScopusAuthError(`Scopus session is not authorized for source ${sourceId} (HTTP ${part.status}).`);
    }
  }

  const parse = <T>(part: FetchResult): T | null => {
    if (part.status !== 200 || !part.text) return null;
    try {
      return JSON.parse(part.text) as T;
    } catch {
      return null;
    }
  };

  return {
    id: sourceId,
    journals: parse<ScopusJournalMetrics>(result.metrics),
    citescore: parse<ScopusCiteScore>(result.citescore),
  };
}

export function recordIsComplete(record: JournalRecord): boolean {
  if (!record.journals?.sourceTitle) return false;
  // A citescore object with a code is a gateway error, so allow a retry.
  if (record.citescore !== null && !Array.isArray(record.citescore)) return false;
  return true;
}

export async function fetchSourceIdsFromDocuments(dir: string): Promise<string[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const ids = new Set<string>();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(await readFile(join(dir, file), "utf8")) as {
        items?: Array<{ source?: { id?: string } }>;
      };
      for (const item of data.items ?? []) {
        const id = item.source?.id;
        if (id) ids.add(String(id));
      }
    } catch {
      // ignore broken files, format-data will report them
    }
  }
  return [...ids].sort();
}

export async function readSourceIdFile(path: string): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  return text
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter((value) => /^\d{3,}$/.test(value));
}

export const JOURNAL_DELAY_MAX = config.scopus.journalDelayMs;
