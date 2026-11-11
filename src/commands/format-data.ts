import { logger } from "../lib/logger.ts";
import { formatAuthors } from "../format-data/authors.ts";
import { formatJournals } from "../format-data/journals.ts";

const log = logger("format-data");

export async function runFormatAuthors(): Promise<void> {
  const summary = await formatAuthors();
  log.info(`author profiles: ${summary.profiles}, author documents: ${summary.documents}`);
}

export async function runFormatJournals(): Promise<void> {
  const summary = await formatJournals();
  log.info(`journals: ${summary.journals}, citescore rows: ${summary.citescore}, quartile rows: ${summary.quartiles}`);
}

export async function runFormatAll(): Promise<void> {
  await runFormatAuthors();
  await runFormatJournals();
  log.info("format-data complete");
}
