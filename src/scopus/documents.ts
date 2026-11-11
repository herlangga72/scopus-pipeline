import { config } from "../config.ts";
import type { Page } from "../cdp/page.ts";
import { logger, sleep } from "../lib/logger.ts";
import { ensureScopusPage, ScopusAuthError } from "./authors.ts";
import type { ScopusDocumentItem, ScopusDocumentSearch } from "./types.ts";

const log = logger("documents");
const PAGE_SIZE = 200;
const DETAIL_CONCURRENCY = 4;

type GatewayResult = { status: number; text: string };

type DocumentListPage = {
  metadata?: {
    offset?: number;
    totalCount?: number;
    itemCount?: number;
  };
  items?: Array<Record<string, unknown>>;
};

async function gatewayJson<T>(page: Page, url: string): Promise<T | null> {
  const result = await page.evaluate<GatewayResult>(
    `(async () => {
      const response = await fetch(${JSON.stringify(url)}, { headers: { Accept: 'application/json' } });
      return { status: response.status, text: await response.text() };
    })()`,
  );
  if (result.status === 401 || result.status === 403) {
    throw new ScopusAuthError(`Scopus session is not authorized (HTTP ${result.status}). Sign in in the Chrome profile.`);
  }
  if (result.status !== 200) {
    log.debug(`gateway ${result.status} ${url}`);
    return null;
  }
  try {
    return JSON.parse(result.text) as T;
  } catch {
    return null;
  }
}

/**
 * Load all document list pages for an author. The author profile page fetches
 * this same endpoint, but direct calls let us paginate past the first page.
 */
export async function fetchDocumentList(page: Page, scopusId: string): Promise<DocumentListPage | null> {
  await ensureScopusPage(page);
  const base = `/gateway/author-profile-api/authors/${encodeURIComponent(scopusId)}/documents`;
  const items: Array<Record<string, unknown>> = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  let metadata: DocumentListPage["metadata"] = {};

  while (offset < total) {
    const url = `${base}?itemCount=${PAGE_SIZE}&offset=${offset}&sort=PUBLICATION_DATE&direction=DESC`;
    const pageData = await gatewayJson<DocumentListPage>(page, url);
    if (!pageData) {
      return offset === 0 ? null : { metadata, items };
    }
    metadata = pageData.metadata ?? metadata;
    const pageItems = pageData.items ?? [];
    items.push(...pageItems);
    total = Number(metadata.totalCount ?? items.length);
    if (pageItems.length === 0) break;
    offset += pageItems.length;
    if (offset < total) await sleep(config.scopus.requestDelayMs);
  }

  return {
    metadata: { ...metadata, itemCount: items.length, totalCount: total === Number.POSITIVE_INFINITY ? items.length : total },
    items,
  };
}

async function fetchDocumentDetail(page: Page, documentId: string): Promise<Record<string, unknown> | null> {
  const eid = documentId.startsWith("2-s2.0-") ? documentId : `2-s2.0-${documentId}`;
  return gatewayJson<Record<string, unknown>>(page, `/gateway/doc-details/documents/${encodeURIComponent(eid)}`);
}

function normalizeAuthors(item: Record<string, unknown>, detail: Record<string, unknown> | null): ScopusDocumentItem["authors"] {
  const detailAuthors = Array.isArray(detail?.authors) ? detail.authors : [];
  const listAuthors = Array.isArray(item.authors) ? item.authors : [];
  const source = detailAuthors.length > 0 ? detailAuthors : listAuthors;

  return source.map((raw) => {
    const author = raw as Record<string, unknown>;
    const preferred = author.preferredName as { first?: string; last?: string; full?: string } | undefined;
    const full = preferred?.full ?? (author.name as string | undefined) ?? [author.preferredFirstName, author.preferredLastName].filter(Boolean).join(" ");
    return {
      authorId: (author.authorId as string | undefined) ?? (author.id as string | undefined),
      preferredName: {
        first: preferred?.first ?? (author.preferredFirstName as string | undefined) ?? (author.firstName as string | undefined) ?? "",
        last: preferred?.last ?? (author.preferredLastName as string | undefined) ?? (author.lastName as string | undefined) ?? "",
        full,
      },
      email: (author.email as string | null | undefined) ?? null,
      affiliationReferences: (author.affiliationReferences as string[] | undefined) ?? [],
    };
  });
}

export function normalizeDocumentItem(item: Record<string, unknown>, detail: Record<string, unknown> | null): ScopusDocumentItem {
  const documentId = String(item.documentId ?? "");
  const eid = (detail?.eid as string | undefined) ?? (documentId ? `2-s2.0-${documentId}` : "");
  const scopusId = eid.includes("-") ? eid.slice(eid.lastIndexOf("-") + 1) : documentId;
  const titles = (detail?.titles as string[] | undefined) ?? (item.titles as string[] | undefined) ?? [];
  const detailSource = (detail?.source ?? {}) as Record<string, unknown>;
  const listSource = (item.source ?? {}) as Record<string, unknown>;
  const detailYear = detail?.publicationYear as string | number | undefined;
  const publicationDate = item.publicationDate as string | undefined;
  const authors = normalizeAuthors(item, detail) ?? [];
  const subjectCodes = (detailSource.subjectAreaCodes as string[] | undefined) ?? [];

  return {
    eid,
    scopusId,
    doi: (detail?.doi as string | undefined) ?? (item.doi as string | undefined) ?? "",
    title: titles[0] ?? "",
    titles,
    pubYear: detailYear ?? (publicationDate ? publicationDate.slice(0, 4) : ""),
    documentType: String(item.documentType ?? ""),
    citations: { count: Number(item.citationCount ?? 0) },
    references: { count: 0 },
    totalAuthors: Number(detail?.authorCount ?? item.totalAuthors ?? authors.length) || authors.length,
    authors,
    subjectAreas: subjectCodes.map((code) => ({ code: Number(code) })),
    source: {
      id: String(detailSource.id ?? listSource.id ?? ""),
      title: String(detailSource.title ?? listSource.title ?? ""),
      publisher: String(detailSource.publisher ?? ""),
      issn: String(detailSource.issn ?? (Array.isArray(listSource.issn) ? listSource.issn[0] : listSource.issn) ?? ""),
      eissn: "",
      sourceType: String(detailSource.type ?? listSource.sourceType ?? ""),
    },
    abstractText: (detail?.abstract as string[] | undefined) ?? [],
  };
}

async function enrichItems(
  page: Page,
  items: Array<Record<string, unknown>>,
  waitMs: number,
): Promise<ScopusDocumentItem[]> {
  const deadline = Date.now() + waitMs;
  const output: ScopusDocumentItem[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = index++;
      const item = items[current]!;
      const documentId = String(item.documentId ?? "");
      let detail: Record<string, unknown> | null = null;
      if (documentId && Date.now() < deadline) {
        try {
          detail = await fetchDocumentDetail(page, documentId);
        } catch (error) {
          if (error instanceof ScopusAuthError) throw error;
          log.debug(`detail failed for ${documentId}`, String(error));
        }
      }
      output[current] = normalizeDocumentItem(item, detail);
    }
  }

  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, items.length) }, () => worker()));
  return output;
}

/**
 * Collect an author's documents from the author-profile gateway, then enrich
 * each record with the document detail endpoint for abstract and source data.
 */
export async function captureAuthorDocuments(
  page: Page,
  scopusId: string,
  options?: { waitMs?: number; details?: boolean },
): Promise<ScopusDocumentSearch | null> {
  const waitMs = options?.waitMs ?? config.scopus.documentWaitMs;
  const list = await fetchDocumentList(page, scopusId);
  if (!list) return null;

  const rawItems = list.items ?? [];
  const items =
    options?.details === false
      ? rawItems.map((item) => normalizeDocumentItem(item, null))
      : await enrichItems(page, rawItems, waitMs);

  return {
    metadata: {
      ...list.metadata,
      itemCount: items.length,
      numberOfPages: items.length > 0 ? Math.ceil(items.length / PAGE_SIZE) : 0,
      message: "",
      facets: {},
    },
    items,
  };
}

export function mergeDocumentResponses(responses: ScopusDocumentSearch[]): ScopusDocumentSearch | null {
  if (responses.length === 0) return null;
  const first = responses[0]!;
  const seen = new Set<string>();
  const items = [];
  for (const response of responses) {
    for (const item of response.items ?? []) {
      const key = item.eid ?? item.scopusId ?? `${item.title}:${item.pubYear}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return {
    ...first,
    metadata: {
      ...first.metadata,
      itemCount: items.length,
      totalCount: first.metadata?.totalCount ?? items.length,
    },
    items,
  };
}
