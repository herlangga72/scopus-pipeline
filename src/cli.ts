#!/usr/bin/env bun
import { Command, Option } from "commander";
import { logger } from "./lib/logger.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runLogin } from "./commands/login.ts";
import { runAuthorDocuments, runAuthorProfiles, runAuthorsAll } from "./commands/authors.ts";
import { runJournalsFetch } from "./commands/journals.ts";
import { runFormatAll, runFormatAuthors, runFormatJournals } from "./commands/format-data.ts";
import { runAffiliationReport } from "./report.ts";
import { browserStatus, closeBrowser, ensureBrowser } from "./cdp/browser.ts";

const log = logger("cli");

function integer(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid number: ${value}`);
  return parsed;
}

function applyAuthorOptions(command: Command): Command {
  return command
    .option("-i, --ids <file>", "file with Scopus author IDs (txt or CSV with Auth-ID)")
    .option("--seed <file>", "seed file with Scopus author IDs")
    .option("--from-profiles", "use IDs already cached in data/raw/author-profiles")
    .option("-f, --force", "refetch even when a cached file exists")
    .option("-n, --limit <number>", "process at most N IDs", integer)
    .option("--wait-ms <number>", "document detail enrichment time per author", integer)
    .option("--no-details", "skip per-document detail enrichment")
    .option("--no-launch", "attach to a running Chrome instead of launching one")
    .option("--headless", "launch Chrome headless (session must already be logged in)");
}

const program = new Command();
program
  .name("scopus")
  .description("Scopus pipeline for authors, documents, and journals")
  .version("0.1.0")
  .enablePositionalOptions()
  .showHelpAfterError()
  .option("--author", "fetch author profiles")
  .option("--document", "fetch author document lists")
  .option("--journals-quartile", "fetch journal metrics and compute CiteScore quartiles")
  .option("--all", "run author, document, and journals-quartile steps")
  .option("-i, --ids <file>", "author ID file (txt or CSV with Auth-ID)")
  .option("--seed <file>", "seed file with author IDs, for example --seed data/seed/example.csv")
  .option("--source-ids <file>", "journal source ID file for journals-quartile")
  .option("--from-profiles", "use IDs already cached in data/raw/author-profiles")
  .option("--from-documents", "use source IDs found in cached author documents")
  .option("-f, --force", "refetch even when a cached file exists")
  .option("-n, --limit <number>", "process at most N records", integer)
  .option("--wait-ms <number>", "document detail enrichment time per author", integer)
  .option("--no-details", "skip per-document detail enrichment")
  .option("--no-launch", "attach to a running Chrome instead of launching one")
  .option("--headless", "launch Chrome headless (session must already be logged in)")
  .action(async (options) => {
    const wantAuthor = Boolean(options.all || options.author);
    const wantDocument = Boolean(options.all || options.document);
    const wantJournals = Boolean(options.all || options.journalsQuartile);

    if (!wantAuthor && !wantDocument && !wantJournals) {
      program.help();
      return;
    }

    const authorOptions = {
      ids: options.ids,
      seed: options.seed,
      fromProfiles: options.fromProfiles,
      force: options.force,
      limit: options.limit,
      waitMs: options.waitMs,
      details: options.details,
      launch: options.launch,
      headless: options.headless,
    };

    if (wantAuthor) await runAuthorProfiles(authorOptions);
    if (wantDocument) await runAuthorDocuments(authorOptions);
    if (wantJournals) {
      await runJournalsFetch({
        ids: options.sourceIds ?? (!wantAuthor && !wantDocument ? options.seed : undefined),
        fromDocuments: options.fromDocuments,
        force: options.force,
        limit: options.limit,
        launch: options.launch,
        headless: options.headless,
      });
      await runFormatJournals();
    }
  });

program
  .command("doctor")
  .description("check Bun, Chrome, CDP, seed data, and optionally the Scopus session")
  .option("--deep", "make a live Scopus gateway request to verify the session")
  .action(async (options: { deep?: boolean }) => {
    await runDoctor(options);
  });

program
  .command("login")
  .description("create the browser profile and open the Scopus sign-in page")
  .option("--url <url>", "login URL")
  .option("--headless", "launch headless (not useful for interactive login)")
  .action(async (options: { url?: string; headless?: boolean }) => {
    await runLogin(options);
  });

program
  .command("browser")
  .description("launch, inspect, or close the managed Chrome instance")
  .argument("[action]", "launch | status | close", "launch")
  .option("--headless", "start headless (session must already be logged in)")
  .action(async (action: string, options: { headless?: boolean }) => {
    if (action === "status") {
      const status = await browserStatus();
      log.info(`reachable=${status.reachable} binary=${status.binary}`);
      log.info(`profile=${status.profile}`);
      if (status.version) log.info(`chrome=${String(status.version["Browser"] ?? "unknown")}`);
      for (const target of status.targets ?? []) log.info(`tab ${target.type} ${target.title ?? ""} ${target.url}`);
      return;
    }
    if (action === "close") {
      await closeBrowser();
      log.info("close requested");
      return;
    }
    if (action !== "launch") throw new Error(`unknown browser action: ${action}`);
    const result = await ensureBrowser({ headless: options.headless });
    log.info(result.attached ? `already running on port ${result.port}` : `launched pid=${result.pid} port=${result.port}`);
    log.info("sign in to Scopus in this browser window if the session is not active yet");
  });

const authors = program.command("authors").description("author profile and document collection");
applyAuthorOptions(authors.command("profiles").description("fetch author profiles through the author GraphQL gateway")).action(
  async (options) => {
    await runAuthorProfiles(options);
  },
);
applyAuthorOptions(authors.command("documents").description("capture author document lists from the profile page")).action(
  async (options) => {
    await runAuthorDocuments(options);
  },
);
applyAuthorOptions(authors.command("all").description("profiles then documents")).action(async (options) => {
  await runAuthorsAll(options);
});

const journals = program.command("journals").description("journal metrics and CiteScore collection");
journals
  .command("fetch")
  .description("fetch source metrics and CiteScore from the Scopus gateway")
  .option("-i, --ids <file>", "file with Scopus source IDs")
  .option("--seed <file>", "seed file with Scopus source IDs")
  .option("--from-documents", "only use source IDs found in cached author documents")
  .option("-f, --force", "refetch even when a cached record exists")
  .option("-n, --limit <number>", "process at most N source IDs", integer)
  .option("--no-launch", "attach to a running Chrome instead of launching one")
  .option("--headless", "launch Chrome headless")
  .action(async (options) => {
    await runJournalsFetch({ ...options, ids: options.ids ?? options.seed });
  });

program
  .command("format-data")
  .description("build JSON and CSV outputs from cached raw JSON")
  .argument("[target]", "all | authors | journals", "all")
  .action(async (target: string) => {
    if (target === "authors") return runFormatAuthors();
    if (target === "journals") return runFormatJournals();
    if (target === "all") return runFormatAll();
    throw new Error(`unknown format-data target: ${target}`);
  });

program
  .command("report")
  .description("build affiliation reports from cached profiles")
  .argument("[target]", "affiliations", "affiliations")
  .action(async (target: string) => {
    if (target !== "affiliations") throw new Error(`unknown report target: ${target}`);
    const { summary, reportPath } = await runAffiliationReport();
    log.info(
      `profiles=${summary.total} ok=${summary.ok} home=${summary.home} other=${summary.other} blank=${summary.blank} not_found=${summary.notFound}`,
    );
    log.info(`report: ${reportPath}`);
  });

program.addOption(new Option("--verbose", "enable debug logging").hideHelp());

program.hook("preAction", (thisCommand) => {
  if (thisCommand.opts().verbose) Bun.env.LOG_LEVEL = "debug";
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  log.error(error instanceof Error ? error.message : String(error));
  if (Bun.env.LOG_LEVEL === "debug" && error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
}
