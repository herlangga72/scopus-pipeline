import { config } from "../config.ts";
import type { Page } from "../cdp/page.ts";
import { sleep } from "../lib/logger.ts";
import type { AuthorProfileRow, ScopusAuthorProfile } from "./types.ts";

export class ScopusAuthError extends Error {
  override name = "ScopusAuthError";
}

const SCOPUS_ORIGIN = "https://www.scopus.com";

export async function ensureScopusPage(page: Page): Promise<void> {
  const current = await page.url();
  if (!current.startsWith(SCOPUS_ORIGIN)) {
    await page.navigate(`${SCOPUS_ORIGIN}/`);
  }
}

type GatewayResult = { status: number; text: string };

export async function graphql(page: Page, query: string): Promise<Record<string, unknown>> {
  await ensureScopusPage(page);
  const payload = JSON.stringify({ query });
  const result = await page.evaluate<GatewayResult>(
    `(async () => {
      const response = await fetch('/gateway/author-profile-api/author', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: ${JSON.stringify(payload)},
      });
      return { status: response.status, text: await response.text() };
    })()`,
  );

  if (result.status === 401 || result.status === 403) {
    throw new ScopusAuthError(`Scopus session is not authorized (HTTP ${result.status}). Sign in in the Chrome profile.`);
  }
  if (result.status !== 200) {
    throw new Error(`Scopus gateway HTTP ${result.status}: ${result.text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(result.text) as Record<string, unknown>;
  } catch {
    throw new ScopusAuthError("Scopus returned HTML instead of JSON. The session is probably logged out.");
  }
}

export function authorQuery(ids: string[]): string {
  const aliases = ids.map((_, index) => `a${index}`);
  const parts = ids
    .map((id, index) => `a${index}: author(id: "${id}") { ${config.scopus.authorQuery} }`)
    .join(" ");
  void aliases;
  return `{ ${parts} }`;
}

export function singleAuthorQuery(id: string): string {
  return `{ author(id: "${id}") { ${config.scopus.authorQuery} } }`;
}

export async function fetchProfiles(page: Page, ids: string[]): Promise<Record<string, ScopusAuthorProfile | null>> {
  const aliases = ids.map((_, index) => `a${index}`);
  const payload = await graphql(page, authorQuery(ids));
  const data = (payload.data ?? {}) as Record<string, ScopusAuthorProfile | null>;
  const out: Record<string, ScopusAuthorProfile | null> = {};

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]!;
    const author = data[aliases[index]!] ?? null;
    out[id] = author && typeof author === "object" ? author : null;
  }

  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  const retry = ids.filter((id) => out[id] === null);
  if (retry.length > 0 && errors.length > 0) {
    for (const id of retry) {
      try {
        const single = await graphql(page, singleAuthorQuery(id));
        const author = ((single.data ?? {}) as Record<string, ScopusAuthorProfile | null>).author ?? null;
        out[id] = author;
      } catch (error) {
        if (error instanceof ScopusAuthError) throw error;
      }
      await sleep(config.scopus.requestDelayMs);
    }
  }

  return out;
}

export async function fetchAuthorIdsFromScopus(page: Page, ids: string[]): Promise<Record<string, ScopusAuthorProfile | null>> {
  const results: Record<string, ScopusAuthorProfile | null> = {};
  for (let start = 0; start < ids.length; start += config.scopus.profileBatchSize) {
    const batch = ids.slice(start, start + config.scopus.profileBatchSize);
    const result = await fetchProfiles(page, batch);
    Object.assign(results, result);
    await sleep(config.scopus.requestDelayMs);
  }
  return results;
}

export function flattenProfile(scopusId: string, author: ScopusAuthorProfile | null | undefined): AuthorProfileRow {
  if (!author) {
    return emptyProfileRow(scopusId, "not_found");
  }
  const profile = author.profile ?? {};
  const metrics = author.metrics ?? {};
  const institution = profile.currentInstitution ?? {};
  const history = profile.institutionHistory ?? [];
  const historyText = history
    .filter((item) => item.name)
    .map((item) => [item.name, item.city, item.country, item.dateRange].filter(Boolean).join(" | "))
    .join("; ");

  const email = profile.emailAddress ?? "";
  return {
    username: email,
    username_local: email.split("@", 1)[0] ?? "",
    Name: profile.preferredName ?? "",
    scopus_id: scopusId,
    resolved_scopus_id: author.id && String(author.id) !== scopusId ? String(author.id) : "",
    affiliation: institution.name ?? "",
    city: institution.city ?? "",
    state: institution.state ?? "",
    country: institution.country ?? "",
    orcid: profile.orcId ?? "",
    documents: metrics.documentCount == null ? "" : String(metrics.documentCount),
    citations: metrics.citationCount == null ? "" : String(metrics.citationCount),
    cited_by: metrics.citedByCount == null ? "" : String(metrics.citedByCount),
    h_index: metrics.hindex == null ? "" : String(metrics.hindex),
    coauthors: metrics.coAuthorsCount == null ? "" : String(metrics.coAuthorsCount),
    institution_history: historyText,
    status: profile.preferredName ? "ok" : "empty_profile",
  };
}

export function emptyProfileRow(scopusId: string, status: AuthorProfileRow["status"]): AuthorProfileRow {
  return {
    username: "",
    username_local: "",
    Name: "",
    scopus_id: scopusId,
    resolved_scopus_id: "",
    affiliation: "",
    city: "",
    state: "",
    country: "",
    orcid: "",
    documents: "",
    citations: "",
    cited_by: "",
    h_index: "",
    coauthors: "",
    institution_history: "",
    status,
  };
}
