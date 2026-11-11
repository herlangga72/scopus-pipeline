import { resolve } from "node:path";

function env(name: string, fallback: string): string {
  const value = Bun.env[name];
  return value && value.length > 0 ? value : fallback;
}

function num(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const root = resolve(import.meta.dir, "..");
const dataDir = resolve(root, env("DATA_DIR", "data"));

export const config = {
  root,
  dataDir,
  paths: {
    seedAuthorIds: resolve(dataDir, env("SEED_AUTHOR_IDS", "seed/example.csv")),
    rawAuthorProfiles: resolve(dataDir, "raw/author-profiles"),
    rawAuthorDocuments: resolve(dataDir, "raw/author-documents"),
    rawJournals: resolve(dataDir, "raw/journals"),
    outDir: resolve(dataDir, "out"),
  },
  scopus: {
    baseUrl: env("SCOPUS_BASE_URL", "https://www.scopus.com"),
    authorQuery: env(
      "SCOPUS_AUTHOR_QUERY",
      `id profile { preferredName preferredFirstName preferredLastName orcId emailAddress currentInstitution { id name parent parentName city state country } institutionHistory { name city state country dateRange } } metrics { documentCount citationCount citedByCount hindex coAuthorsCount }`,
    ),
    profileBatchSize: num("SCOPUS_PROFILE_BATCH_SIZE", 25),
    requestDelayMs: num("SCOPUS_REQUEST_DELAY_MS", 400),
    journalDelayMs: num("SCOPUS_JOURNAL_DELAY_MS", 300),
    documentWaitMs: num("SCOPUS_DOCUMENT_WAIT_MS", 120_000),
  },
  cdp: {
    port: num("SCOPUS_CDP_PORT", 9222),
    host: env("SCOPUS_CDP_HOST", "127.0.0.1"),
    timeoutMs: num("SCOPUS_CDP_TIMEOUT_MS", 90_000),
  },
  chrome: {
    binary: env("CHROME_BIN", "google-chrome"),
    userDataDir: env("CHROME_USER_DATA_DIR", resolve(dataDir, "browser-profile")),
    profileDirectory: env("CHROME_PROFILE_DIRECTORY", "Scopus"),
    debugPort: num("CHROME_DEBUG_PORT", 9222),
    windowSize: env("CHROME_WINDOW_SIZE", "1920,1080"),
  },
  report: {
    // Set this in .env to match your own institution. The default matches nothing.
    homeInstitutionPattern: env("HOME_INSTITUTION_PATTERN", "$^"),
  },
} as const;

export type Config = typeof config;
