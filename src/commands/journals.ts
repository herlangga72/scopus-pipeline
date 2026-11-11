import { join } from "node:path";
import { config } from "../config.ts";
import { exists, listJsonIds, readJson, writeJsonFile } from "../lib/fsx.ts";
import { logger, Progress, sleep } from "../lib/logger.ts";
import { fetchJournalRecord, fetchSourceIdsFromDocuments, readSourceIdFile, recordIsComplete } from "../scopus/journals.ts";
import { ScopusAuthError } from "../scopus/authors.ts";
import { withPage } from "../scopus/session.ts";
import type { JournalRecord } from "../scopus/types.ts";

const log = logger("journals");

export type JournalCommandOptions = {
  ids?: string;
  fromDocuments?: boolean;
  force?: boolean;
  limit?: number;
  launch?: boolean;
  headless?: boolean;
};

async function resolveSourceIds(options: JournalCommandOptions): Promise<string[]> {
  if (options.ids) return readSourceIdFile(options.ids);

  const fromDocuments = await fetchSourceIdsFromDocuments(config.paths.rawAuthorDocuments);
  if (options.fromDocuments) return fromDocuments;

  const existing = await listJsonIds(config.paths.rawJournals);
  return [...new Set([...existing, ...fromDocuments])].sort();
}

export async function runJournalsFetch(options: JournalCommandOptions): Promise<void> {
  const all = await resolveSourceIds(options);
  const ids = options.limit && options.limit > 0 ? all.slice(0, options.limit) : all;
  if (ids.length === 0) {
    throw new Error(
      "no source IDs found. Fetch author documents first, pass --ids <file>, or copy data into data/raw/author-documents.",
    );
  }

  const todo: string[] = [];
  for (const id of ids) {
    if (options.force) {
      todo.push(id);
      continue;
    }
    const path = join(config.paths.rawJournals, `${id}.json`);
    if (!(await exists(path))) {
      todo.push(id);
      continue;
    }
    try {
      const record = await readJson<JournalRecord>(path);
      if (!recordIsComplete(record)) todo.push(id);
    } catch {
      todo.push(id);
    }
  }

  log.info(`journals: ${ids.length} requested, ${todo.length} to fetch, ${ids.length - todo.length} already cached`);
  if (todo.length === 0) return;

  await withPage(
    async (page) => {
      const progress = new Progress(todo.length, "journals", log);
      for (const id of todo) {
        try {
          const record = await fetchJournalRecord(page, id);
          await writeJsonFile(join(config.paths.rawJournals, `${id}.json`), record);
          progress.tick(recordIsComplete(record), id);
        } catch (error) {
          progress.tick(false, `${id} ${String(error)}`);
          if (error instanceof ScopusAuthError) throw error;
        }
        await sleep(config.scopus.journalDelayMs + Math.floor(Math.random() * 250));
      }
    },
    { launch: options.launch, headless: options.headless },
  );
}
