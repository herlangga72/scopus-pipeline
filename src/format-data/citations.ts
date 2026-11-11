import { join } from "node:path";
import { config } from "../config.ts";
import { ensureDir, listJsonIds, readJson, writeFileAtomic, writeJsonFile } from "../lib/fsx.ts";
import { toCsv, type Row } from "../lib/csv.ts";
import { logger } from "../lib/logger.ts";
import { ALL_CITATION_VARIANTS } from "../scopus/citations.ts";
import type { CitationOverviewDocument, CitationOverviewRaw, CitationVariant } from "../scopus/types.ts";
import { loadProfileRows } from "./authors.ts";

const log = logger("format-citations");

export type CitationLongRow = {
  scopus_id: string;
  document_id: string;
  title: string;
  pub_year: string;
  source_title: string;
  issn: string;
  volume: string;
  issue: string;
  variant: CitationVariant;
  citation_year: number;
  citations: number;
};

export const CITATION_LONG_COLUMNS: Array<keyof CitationLongRow> = [
  "scopus_id",
  "document_id",
  "title",
  "pub_year",
  "source_title",
  "issn",
  "volume",
  "issue",
  "variant",
  "citation_year",
  "citations",
];

/** Totals per variant plus the counts derived from them. Missing variant -> "". */
type Totals = {
  all: number | "";
  excl_self_selected: number | "";
  excl_self_all: number | "";
  excl_book: number | "";
  self_selected: number | "";
  self_all: number | "";
  book: number | "";
};

const TOTAL_KEYS: Array<keyof Totals> = [
  "all",
  "excl_self_selected",
  "excl_self_all",
  "excl_book",
  "self_selected",
  "self_all",
  "book",
];

export type DocumentCitationRow = {
  scopus_id: string;
  document_id: string;
  title: string;
  pub_year: string;
  source_title: string;
} & { [K in keyof Totals as `total_${K}`]: Totals[K] } & Record<`y${number}`, number>;

export type AuthorYearRow = { scopus_id: string; name: string; citation_year: number } & Totals;

const VARIANT_KEY: Record<CitationVariant, keyof Totals> = {
  all: "all",
  "excl-self-selected": "excl_self_selected",
  "excl-self-all": "excl_self_all",
  "excl-book": "excl_book",
};

function yearsOf(start: number, end: number): number[] {
  const years: number[] = [];
  for (let year = start; year <= end; year += 1) years.push(year);
  return years;
}

/** Sparse map year -> citations. Scopus sends startYear === endYear per bucket. */
export function annualCounts(document: CitationOverviewDocument): Map<number, number> {
  const counts = new Map<number, number>();
  for (const bucket of document.annualReferencedBy ?? []) {
    if (bucket.endYear != null && bucket.startYear !== bucket.endYear) {
      log.warn(`document ${document.id}: multi-year bucket ${bucket.startYear}-${bucket.endYear}, using startYear`);
    }
    const year = Number(bucket.startYear);
    if (!Number.isFinite(year)) continue;
    counts.set(year, (counts.get(year) ?? 0) + Number(bucket.referencedByCount ?? 0));
  }
  return counts;
}

function sum(counts: Map<number, number> | undefined, years?: number[]): number {
  if (!counts) return 0;
  if (!years) return [...counts.values()].reduce((a, b) => a + b, 0);
  return years.reduce((total, year) => total + (counts.get(year) ?? 0), 0);
}

function diff(a: number | "", b: number | ""): number | "" {
  return a === "" || b === "" ? "" : Math.max(0, a - b);
}

function withDerived(base: Pick<Totals, "all" | "excl_self_selected" | "excl_self_all" | "excl_book">): Totals {
  return {
    ...base,
    self_selected: diff(base.all, base.excl_self_selected),
    self_all: diff(base.all, base.excl_self_all),
    book: diff(base.all, base.excl_book),
  };
}

function documentMeta(document: CitationOverviewDocument) {
  return {
    title: document.itemTitle?.[0] ?? "",
    pub_year: document.publicationYear == null ? "" : String(document.publicationYear),
    source_title: document.sourceTitle ?? "",
    issn: (document.issn ?? []).join("; "),
    volume: document.volume ?? "",
    issue: document.issue ?? "",
  };
}

/** Per-variant, per-document annual counts, keyed by document id. */
function indexVariants(raw: CitationOverviewRaw) {
  const metaById = new Map<string, CitationOverviewDocument>();
  const counts = {} as Record<CitationVariant, Map<string, Map<number, number>> | undefined>;
  for (const variant of ALL_CITATION_VARIANTS) {
    const data = raw.variants[variant];
    if (!data) continue;
    const byDoc = new Map<string, Map<number, number>>();
    for (const document of data.documents) {
      const id = String(document.id);
      if (!metaById.has(id) || variant === "all") metaById.set(id, document);
      byDoc.set(id, annualCounts(document));
    }
    counts[variant] = byDoc;
  }
  return { metaById, counts };
}

/** Long format: one row per (author, document, variant, year) with citations > 0. */
export function flattenCitationLong(raw: CitationOverviewRaw): CitationLongRow[] {
  const rows: CitationLongRow[] = [];
  for (const variant of ALL_CITATION_VARIANTS) {
    const data = raw.variants[variant];
    if (!data) continue;
    for (const document of data.documents) {
      const meta = documentMeta(document);
      const counts = [...annualCounts(document).entries()].sort((a, b) => a[0] - b[0]);
      for (const [year, citations] of counts) {
        if (citations <= 0) continue;
        rows.push({
          scopus_id: raw.authorId,
          document_id: String(document.id),
          ...meta,
          variant,
          citation_year: year,
          citations,
        });
      }
    }
  }
  return rows;
}

/** One row per document with variant totals and a dense y<YEAR> series for "all". */
export function buildDocumentCitationRows(raw: CitationOverviewRaw, yearStart: number, yearEnd: number): DocumentCitationRow[] {
  const years = yearsOf(yearStart, yearEnd);
  const { metaById, counts } = indexVariants(raw);
  const rows: DocumentCitationRow[] = [];

  for (const [id, document] of metaById) {
    const meta = documentMeta(document);
    const base = {} as Pick<Totals, "all" | "excl_self_selected" | "excl_self_all" | "excl_book">;
    for (const variant of ALL_CITATION_VARIANTS) {
      const byDoc = counts[variant];
      base[VARIANT_KEY[variant] as keyof typeof base] = byDoc ? sum(byDoc.get(id)) : "";
    }
    const totals = withDerived(base);
    const row: Record<string, unknown> = {
      scopus_id: raw.authorId,
      document_id: id,
      title: meta.title,
      pub_year: meta.pub_year,
      source_title: meta.source_title,
    };
    for (const key of TOTAL_KEYS) row[`total_${key}`] = totals[key];
    const allCounts = counts.all?.get(id);
    for (const year of years) row[`y${year}`] = allCounts?.get(year) ?? 0;
    rows.push(row as DocumentCitationRow);
  }
  return rows;
}

/** One row per (author, citation year) summed over all documents. */
export function buildAuthorYearRows(raw: CitationOverviewRaw, name = ""): AuthorYearRow[] {
  const { counts } = indexVariants(raw);
  const yearSet = new Set<number>();
  for (const variant of ALL_CITATION_VARIANTS) {
    for (const docCounts of counts[variant]?.values() ?? []) for (const year of docCounts.keys()) yearSet.add(year);
  }
  const years = [...yearSet].sort((a, b) => a - b);

  return years.map((year) => {
    const base = {} as Pick<Totals, "all" | "excl_self_selected" | "excl_self_all" | "excl_book">;
    for (const variant of ALL_CITATION_VARIANTS) {
      const byDoc = counts[variant];
      base[VARIANT_KEY[variant] as keyof typeof base] = byDoc
        ? [...byDoc.values()].reduce((total, docCounts) => total + (docCounts.get(year) ?? 0), 0)
        : "";
    }
    return { scopus_id: raw.authorId, name, citation_year: year, ...withDerived(base) };
  });
}

export async function formatCitations(): Promise<{ authors: number; documents: number; rows: number }> {
  await ensureDir(config.paths.outDir);
  const ids = await listJsonIds(config.paths.rawCitationOverview);

  const names = new Map<string, string>();
  try {
    const { rows } = await loadProfileRows();
    for (const row of rows) names.set(row.scopus_id, row.Name);
  } catch {
    // profiles are optional for this output
  }

  const raws: CitationOverviewRaw[] = [];
  for (const id of ids) raws.push(await readJson<CitationOverviewRaw>(join(config.paths.rawCitationOverview, `${id}.json`)));

  const yearStart = Math.min(config.scopus.citationYearStart, ...raws.map((raw) => raw.yearRangeStart));
  const yearEnd = Math.max(config.scopus.citationYearEnd, ...raws.map((raw) => raw.yearRangeEnd));
  const yearColumns = yearsOf(yearStart, yearEnd).map((year) => `y${year}`);

  const longRows: CitationLongRow[] = [];
  const documentRows: DocumentCitationRow[] = [];
  const authorRows: AuthorYearRow[] = [];
  for (const raw of raws) {
    longRows.push(...flattenCitationLong(raw));
    documentRows.push(...buildDocumentCitationRows(raw, yearStart, yearEnd));
    authorRows.push(...buildAuthorYearRows(raw, names.get(raw.authorId) ?? ""));
  }

  const out = config.paths.outDir;
  await writeFileAtomic(join(out, "citation-overview-long.csv"), toCsv(longRows as unknown as Row[], CITATION_LONG_COLUMNS));
  await writeJsonFile(join(out, "citation-overview-long.json"), longRows);

  const documentColumns = [
    "scopus_id",
    "document_id",
    "title",
    "pub_year",
    "source_title",
    ...TOTAL_KEYS.map((key) => `total_${key}`),
    ...yearColumns,
  ];
  await writeFileAtomic(join(out, "citation-overview-documents.csv"), toCsv(documentRows as unknown as Row[], documentColumns));
  await writeJsonFile(join(out, "citation-overview-documents.json"), documentRows);

  const authorColumns = ["scopus_id", "name", "citation_year", ...TOTAL_KEYS];
  await writeFileAtomic(join(out, "citation-overview-authors.csv"), toCsv(authorRows as unknown as Row[], authorColumns));
  await writeJsonFile(join(out, "citation-overview-authors.json"), authorRows);

  return { authors: raws.length, documents: documentRows.length, rows: longRows.length };
}
