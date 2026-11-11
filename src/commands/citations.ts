import { join } from "node:path";
import { config } from "../config.ts";
import { exists, readJson, writeJsonFile } from "../lib/fsx.ts";
import { logger, Progress, sleep } from "../lib/logger.ts";
import { ScopusAuthError } from "../scopus/authors.ts";
import { fetchCitationOverview, parseVariants } from "../scopus/citations.ts";
import { withPage } from "../scopus/session.ts";
import { formatCitations } from "../format-data/citations.ts";
import type { CitationOverviewRaw, CitationVariant } from "../scopus/types.ts";
import { applyLimit, resolveAuthorIds, type AuthorCommandOptions } from "./authors.ts";

const log = logger("citations");

export type CitationCommandOptions = Pick<
  AuthorCommandOptions,
  "ids" | "seed" | "fromProfiles" | "force" | "limit" | "launch" | "headless"
> & {
  yearStart?: number;
  yearEnd?: number;
  variants?: string;
};

async function readCached(path: string): Promise<CitationOverviewRaw | null> {
  if (!(await exists(path))) return null;
  try {
    return await readJson<CitationOverviewRaw>(path);
  } catch {
    return null;
  }
}

/** A cache file counts as done only if it has every requested variant for the same year range. */
export function isComplete(
  cached: CitationOverviewRaw | null,
  variants: CitationVariant[],
  yearStart: number,
  yearEnd: number,
): boolean {
  if (!cached) return false;
  if (cached.yearRangeStart !== yearStart || cached.yearRangeEnd !== yearEnd) return false;
  return variants.every((variant) => cached.variants?.[variant] != null);
}

export async function runCitationOverview(options: CitationCommandOptions): Promise<void> {
  const ids = applyLimit(await resolveAuthorIds(options), options.limit);
  if (ids.length === 0) {
    throw new Error(`no author IDs found. Pass --ids <file> or put IDs in ${config.paths.seedAuthorIds}`);
  }
  const variants = parseVariants(options.variants);
  const yearStart = options.yearStart ?? config.scopus.citationYearStart;
  const yearEnd = options.yearEnd ?? config.scopus.citationYearEnd;
  if (yearStart > yearEnd) throw new Error(`--year-start ${yearStart} is after --year-end ${yearEnd}`);

  const pathOf = (id: string) => join(config.paths.rawCitationOverview, `${id}.json`);
  const todo: string[] = [];
  for (const id of ids) {
    if (options.force || !isComplete(await readCached(pathOf(id)), variants, yearStart, yearEnd)) todo.push(id);
  }
  log.info(
    `citation overview ${yearStart}-${yearEnd} [${variants.join(", ")}]: ${ids.length} requested, ${todo.length} to fetch, ${ids.length - todo.length} already cached`,
  );

  if (todo.length > 0) {
    await withPage(
      async (page) => {
        const progress = new Progress(todo.length, "citations", log);
        for (const id of todo) {
          try {
            const fresh = await fetchCitationOverview(page, id, { yearStart, yearEnd, variants });
            // Keep variants fetched earlier for the same range so --variants runs can be combined.
            const cached = options.force ? null : await readCached(pathOf(id));
            const sameRange = cached && cached.yearRangeStart === yearStart && cached.yearRangeEnd === yearEnd;
            const merged: CitationOverviewRaw = sameRange
              ? { ...fresh, variants: { ...cached.variants, ...fresh.variants } }
              : fresh;
            await writeJsonFile(pathOf(id), merged);
            const docs = fresh.variants.all?.documents.length ?? Object.values(fresh.variants)[0]?.documents.length ?? 0;
            progress.tick(true, `${id} documents=${docs}`);
          } catch (error) {
            progress.tick(false, `${id} ${String(error)}`);
            if (error instanceof ScopusAuthError) throw error;
          }
          await sleep(config.scopus.requestDelayMs);
        }
        const { failed } = progress.summary();
        if (failed > 0) log.warn(`${failed} authors failed; rerun the command to retry them`);
      },
      { launch: options.launch, headless: options.headless },
    );
  }

  const summary = await formatCitations();
  log.info(`citation overview: ${summary.authors} authors, ${summary.documents} documents, ${summary.rows} long rows`);
}
