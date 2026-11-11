import { join } from "node:path";
import { config } from "../config.ts";
import { listJsonIds, writeJsonFile } from "../lib/fsx.ts";
import { readIds } from "../lib/csv.ts";
import { logger, Progress, sleep } from "../lib/logger.ts";
import { captureAuthorDocuments } from "../scopus/documents.ts";
import { fetchProfiles, ScopusAuthError } from "../scopus/authors.ts";
import { withPage } from "../scopus/session.ts";
import { formatAuthors } from "../format-data/authors.ts";
import type { ScopusAuthorProfile, ScopusDocumentSearch } from "../scopus/types.ts";

const log = logger("authors");

export type AuthorCommandOptions = {
  ids?: string;
  seed?: string;
  fromProfiles?: boolean;
  force?: boolean;
  limit?: number;
  waitMs?: number;
  details?: boolean;
  launch?: boolean;
  headless?: boolean;
};

async function resolveAuthorIds(options: AuthorCommandOptions): Promise<string[]> {
  const seedPath = options.ids ?? options.seed;
  if (seedPath) {
    return readIds(seedPath);
  }
  if (options.fromProfiles) {
    return listJsonIds(config.paths.rawAuthorProfiles);
  }
  return readIds(config.paths.seedAuthorIds);
}

function applyLimit(ids: string[], limit?: number): string[] {
  return limit && limit > 0 ? ids.slice(0, limit) : ids;
}

export async function runAuthorProfiles(options: AuthorCommandOptions): Promise<void> {
  const ids = applyLimit(await resolveAuthorIds(options), options.limit);
  if (ids.length === 0) {
    throw new Error(`no author IDs found. Pass --ids <file> or put IDs in ${config.paths.seedAuthorIds}`);
  }

  const existing = new Set(await listJsonIds(config.paths.rawAuthorProfiles));
  const todo = options.force ? ids : ids.filter((id) => !existing.has(id));
  log.info(`profiles: ${ids.length} requested, ${todo.length} to fetch, ${ids.length - todo.length} already cached`);

  if (todo.length > 0) {
    await withPage(
      async (page) => {
        const progress = new Progress(todo.length, "profiles", log);
        let failures = 0;
        for (let start = 0; start < todo.length; start += config.scopus.profileBatchSize) {
          const batch = todo.slice(start, start + config.scopus.profileBatchSize);
          try {
            const result = await fetchProfiles(page, batch);
            for (const id of batch) {
              const profile: ScopusAuthorProfile | null = result[id] ?? null;
              await writeJsonFile(join(config.paths.rawAuthorProfiles, `${id}.json`), profile);
              progress.tick(true, id);
            }
          } catch (error) {
            failures += batch.length;
            for (const id of batch) progress.tick(false, `${id} ${String(error)}`);
            if (error instanceof ScopusAuthError) throw error;
          }
          await sleep(config.scopus.requestDelayMs);
        }
        if (failures > 0) log.warn(`${failures} profile lookups failed`);
      },
      { launch: options.launch, headless: options.headless },
    );
  }

  const summary = await formatAuthors();
  log.info(`wrote ${summary.profiles} profile rows and ${summary.documents} document rows`);
}

export async function runAuthorDocuments(options: AuthorCommandOptions): Promise<void> {
  const ids = applyLimit(await resolveAuthorIds(options), options.limit);
  if (ids.length === 0) {
    throw new Error(`no author IDs found. Pass --ids <file> or run authors:profiles first.`);
  }

  const existing = new Set(await listJsonIds(config.paths.rawAuthorDocuments));
  const todo = options.force ? ids : ids.filter((id) => !existing.has(id));
  log.info(`documents: ${ids.length} requested, ${todo.length} to fetch, ${ids.length - todo.length} already cached`);

  if (todo.length > 0) {
    await withPage(
      async (page) => {
        const progress = new Progress(todo.length, "documents", log);
        for (const id of todo) {
          try {
            const data = await captureAuthorDocuments(page, id, { waitMs: options.waitMs, details: options.details });
            const payload: ScopusDocumentSearch = data ?? {
              metadata: { offset: 0, totalCount: 0, itemCount: 0, numberOfPages: 0, message: "no document search response", facets: {} },
              items: [],
            };
            await writeJsonFile(join(config.paths.rawAuthorDocuments, `${id}.json`), payload);
            progress.tick(true, id);
          } catch (error) {
            progress.tick(false, `${id} ${String(error)}`);
            if (error instanceof ScopusAuthError) throw error;
          }
          await sleep(1_500);
        }
      },
      { launch: options.launch, headless: options.headless },
    );
  }

  const summary = await formatAuthors();
  log.info(`wrote ${summary.profiles} profile rows and ${summary.documents} document rows`);
}

export async function runAuthorsAll(options: AuthorCommandOptions): Promise<void> {
  await runAuthorProfiles(options);
  await runAuthorDocuments(options);
  log.info("authors complete");
}

export const __test = { resolveAuthorIds };
