import { config } from "../config.ts";
import type { Page } from "../cdp/page.ts";
import { logger, sleep } from "../lib/logger.ts";
import { ensureScopusPage, ScopusAuthError } from "./authors.ts";
import type {
  CitationOverviewDocument,
  CitationOverviewPage,
  CitationOverviewRaw,
  CitationOverviewVariantData,
  CitationVariant,
} from "./types.ts";

const log = logger("citations");

export const CITATION_OVERVIEW_URL = "/gateway/citation-overview/authors/citations";

type VariantFlags = {
  excludeSelfCitations: boolean;
  excludeCitationsSelectedAuthor: boolean;
  excludeBookChapterCitations: boolean;
};

/** Each variant toggles one Scopus exclusion filter; "all" is the baseline. */
export const CITATION_VARIANTS: Record<CitationVariant, VariantFlags> = {
  all: { excludeSelfCitations: false, excludeCitationsSelectedAuthor: false, excludeBookChapterCitations: false },
  "excl-self-selected": { excludeSelfCitations: false, excludeCitationsSelectedAuthor: true, excludeBookChapterCitations: false },
  "excl-self-all": { excludeSelfCitations: true, excludeCitationsSelectedAuthor: false, excludeBookChapterCitations: false },
  "excl-book": { excludeSelfCitations: false, excludeCitationsSelectedAuthor: false, excludeBookChapterCitations: true },
};

export const ALL_CITATION_VARIANTS = Object.keys(CITATION_VARIANTS) as CitationVariant[];

export type CitationRange = { yearStart: number; yearEnd: number };

export type CitationFetchOptions = Partial<CitationRange> & {
  pageSize?: number;
  delayMs?: number;
  variants?: CitationVariant[];
  /** Backoff before each retry on 429/5xx. Length = number of retries. */
  retryDelaysMs?: number[];
};

/** Minimal page surface used here, so tests can pass a fake. */
export type GatewayPage = Pick<Page, "evaluate" | "url" | "navigate">;

type GatewayResult = { status: number; text: string };

export function parseVariants(value?: string): CitationVariant[] {
  if (!value) return ALL_CITATION_VARIANTS;
  const variants = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const variant of variants) {
    if (!(variant in CITATION_VARIANTS)) {
      throw new Error(`unknown citation variant: ${variant}. Use one of ${ALL_CITATION_VARIANTS.join(", ")}`);
    }
  }
  return [...new Set(variants)] as CitationVariant[];
}

export function buildCitationRequest(
  authorId: string,
  variant: CitationVariant,
  options: CitationRange & { skip: number; amount: number },
): Record<string, unknown> {
  return {
    ids: [authorId],
    yearRangeStart: options.yearStart,
    yearRangeEnd: options.yearEnd,
    ...CITATION_VARIANTS[variant],
    excludeZeros: false,
    sort: "PUBLICATION_DATE_DESC",
    skip: options.skip,
    amount: options.amount,
  };
}

async function postOnce(page: GatewayPage, url: string, body: unknown): Promise<GatewayResult> {
  return page.evaluate<GatewayResult>(
    `(async () => {
      const response = await fetch(${JSON.stringify(url)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Accept': 'application/json' },
        body: ${JSON.stringify(JSON.stringify(body))},
      });
      return { status: response.status, text: await response.text() };
    })()`,
  );
}

/** POST JSON to a Scopus gateway URL from inside the logged-in tab. */
export async function postGatewayJson<T>(
  page: GatewayPage,
  url: string,
  body: unknown,
  retryDelaysMs: number[] = [2_000, 5_000, 10_000],
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await postOnce(page, url, body);
    if (result.status === 401 || result.status === 403) {
      throw new ScopusAuthError(`Scopus session is not authorized (HTTP ${result.status}). Sign in in the Chrome profile.`);
    }
    const retryable = result.status === 429 || result.status >= 500;
    if (retryable && attempt < retryDelaysMs.length) {
      const wait = retryDelaysMs[attempt]!;
      log.warn(`gateway HTTP ${result.status}, retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (result.status !== 200) {
      throw new Error(`Scopus gateway HTTP ${result.status}: ${result.text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(result.text) as T;
    } catch {
      throw new ScopusAuthError("Scopus returned HTML instead of JSON. The session is probably logged out.");
    }
  }
}

/** Fetch every page of one citation variant for one author. */
export async function fetchCitationVariant(
  page: GatewayPage,
  authorId: string,
  variant: CitationVariant,
  options: CitationRange & { pageSize: number; delayMs: number; retryDelaysMs?: number[] },
): Promise<CitationOverviewVariantData> {
  const byId = new Map<string, CitationOverviewDocument>();
  let skip = 0;
  let total = Number.POSITIVE_INFINITY;

  while (skip < total) {
    const body = buildCitationRequest(authorId, variant, { ...options, skip, amount: options.pageSize });
    const data = await postGatewayJson<CitationOverviewPage>(page, CITATION_OVERVIEW_URL, body, options.retryDelaysMs);
    const documents = data.documents ?? [];
    total = Number(data.totalCount ?? 0);
    for (const document of documents) {
      const key = String(document.id ?? "");
      if (key && !byId.has(key)) byId.set(key, document);
    }
    if (documents.length === 0) break;
    skip += documents.length;
    if (skip < total) await sleep(options.delayMs);
  }

  const totalCount = Number.isFinite(total) ? total : byId.size;
  if (byId.size !== totalCount) {
    log.warn(`${authorId} ${variant}: got ${byId.size} documents, Scopus reported ${totalCount}`);
  }
  return { totalCount, documents: [...byId.values()] };
}

/** Fetch all requested citation variants for one author, one after another. */
export async function fetchCitationOverview(
  page: GatewayPage,
  authorId: string,
  options: CitationFetchOptions = {},
): Promise<CitationOverviewRaw> {
  await ensureScopusPage(page);
  const range: CitationRange = {
    yearStart: options.yearStart ?? config.scopus.citationYearStart,
    yearEnd: options.yearEnd ?? config.scopus.citationYearEnd,
  };
  const pageSize = options.pageSize ?? config.scopus.citationPageSize;
  const delayMs = options.delayMs ?? config.scopus.requestDelayMs;
  const variants = options.variants ?? ALL_CITATION_VARIANTS;

  const raw: CitationOverviewRaw = {
    authorId,
    fetchedAt: new Date().toISOString(),
    yearRangeStart: range.yearStart,
    yearRangeEnd: range.yearEnd,
    variants: {},
  };
  for (const variant of variants) {
    raw.variants[variant] = await fetchCitationVariant(page, authorId, variant, {
      ...range,
      pageSize,
      delayMs,
      retryDelaysMs: options.retryDelaysMs,
    });
    log.debug(`${authorId} ${variant}: ${raw.variants[variant]!.documents.length} documents`);
    await sleep(delayMs);
  }
  return raw;
}
