import { logger } from "../lib/logger.ts";
import { formatAuthors } from "../format-data/authors.ts";
import { formatJournals } from "../format-data/journals.ts";
import { formatCitations } from "../format-data/citations.ts";

const log = logger("format-data");

export async function runFormatAuthors(): Promise<void> {
  const summary = await formatAuthors();
  log.info(`author profiles: ${summary.profiles}, author documents: ${summary.documents}`);
}

export async function runFormatJournals(): Promise<void> {
  const summary = await formatJournals();
  log.info(`journals: ${summary.journals}, citescore rows: ${summary.citescore}, quartile rows: ${summary.quartiles}`);
}

export async function runFormatCitations(): Promise<void> {
  const summary = await formatCitations();
  log.info(`citation overview: ${summary.authors} authors, ${summary.documents} documents, ${summary.rows} long rows`);
}

export async function runFormatAll(): Promise<void> {
  await runFormatAuthors();
  await runFormatJournals();
  await runFormatCitations();
  log.info("format-data complete");
}
