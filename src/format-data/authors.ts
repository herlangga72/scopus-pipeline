import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "../config.ts";
import { listJsonIds, readJson, writeFileAtomic, writeJsonFile } from "../lib/fsx.ts";
import { toCsv, type Row } from "../lib/csv.ts";
import { flattenProfile } from "../scopus/authors.ts";
import { PROFILE_COLUMNS } from "../scopus/types.ts";
import type { AuthorProfileRow, ScopusAuthorProfile, ScopusDocumentItem, ScopusDocumentSearch } from "../scopus/types.ts";

export type DocumentRow = {
  scopus_id: string;
  eid: string;
  document_scopus_id: string;
  doi: string;
  title: string;
  pub_year: string;
  document_type: string;
  source_id: string;
  source_title: string;
  source_publisher: string;
  source_issn: string;
  source_type: string;
  citations: string;
  references: string;
  total_authors: string;
  authors: string;
  author_ids: string;
  subject_areas: string;
  abstract: string;
};

export const DOCUMENT_COLUMNS: Array<keyof DocumentRow> = [
  "scopus_id",
  "eid",
  "document_scopus_id",
  "doi",
  "title",
  "pub_year",
  "document_type",
  "source_id",
  "source_title",
  "source_publisher",
  "source_issn",
  "source_type",
  "citations",
  "references",
  "total_authors",
  "authors",
  "author_ids",
  "subject_areas",
  "abstract",
];

export function flattenDocument(scopusId: string, item: ScopusDocumentItem): DocumentRow {
  const authors = item.authors ?? [];
  const authorNames = authors
    .map((author) => author.preferredName?.full ?? [author.preferredName?.first, author.preferredName?.last].filter(Boolean).join(" "))
    .filter(Boolean);
  return {
    scopus_id: scopusId,
    eid: item.eid ?? "",
    document_scopus_id: item.scopusId ?? "",
    doi: item.doi ?? "",
    title: item.title ?? item.titles?.[0] ?? "",
    pub_year: item.pubYear == null ? "" : String(item.pubYear),
    document_type: item.documentType ?? "",
    source_id: item.source?.id ?? "",
    source_title: item.source?.title ?? "",
    source_publisher: item.source?.publisher ?? "",
    source_issn: item.source?.issn ?? item.source?.eissn ?? "",
    source_type: item.source?.sourceType ?? "",
    citations: item.citations?.count == null ? "" : String(item.citations.count),
    references: item.references?.count == null ? "" : String(item.references.count),
    total_authors: item.totalAuthors == null ? "" : String(item.totalAuthors),
    authors: authorNames.join("; "),
    author_ids: authors.map((author) => author.authorId).filter(Boolean).join("; "),
    subject_areas: (item.subjectAreas ?? []).map((area) => area.displayName ?? area.code).filter(Boolean).join("; "),
    abstract: (item.abstractText ?? []).join(" "),
  };
}

export async function loadProfileRows(): Promise<{ rows: AuthorProfileRow[]; ids: string[] }> {
  const ids = await listJsonIds(config.paths.rawAuthorProfiles);
  const rows: AuthorProfileRow[] = [];
  for (const id of ids) {
    const raw = await readJson<ScopusAuthorProfile | null>(join(config.paths.rawAuthorProfiles, `${id}.json`));
    rows.push(flattenProfile(id, raw));
  }
  return { rows, ids };
}

export async function formatAuthors(): Promise<{ profiles: number; documents: number }> {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(config.paths.outDir, { recursive: true }));

  const profileIds = await listJsonIds(config.paths.rawAuthorProfiles);
  const profileRows: AuthorProfileRow[] = [];
  for (const id of profileIds) {
    const raw = await readJson<ScopusAuthorProfile | null>(join(config.paths.rawAuthorProfiles, `${id}.json`));
    profileRows.push(flattenProfile(id, raw));
  }
  await writeFileAtomic(
    join(config.paths.outDir, "author-profiles.csv"),
    toCsv(profileRows as unknown as Row[], PROFILE_COLUMNS as string[]),
  );
  await writeJsonFile(join(config.paths.outDir, "author-profiles.json"), profileRows);

  const documentRows: DocumentRow[] = [];
  const documentIds = await listJsonIds(config.paths.rawAuthorDocuments);
  for (const scopusId of documentIds) {
    const data = await readJson<ScopusDocumentSearch>(join(config.paths.rawAuthorDocuments, `${scopusId}.json`));
    for (const item of data.items ?? []) {
      documentRows.push(flattenDocument(scopusId, item));
    }
  }
  await writeFileAtomic(
    join(config.paths.outDir, "author-documents.csv"),
    toCsv(documentRows as unknown as Row[], DOCUMENT_COLUMNS as string[]),
  );
  await writeJsonFile(join(config.paths.outDir, "author-documents.json"), documentRows);

  return { profiles: profileRows.length, documents: documentRows.length };
}

export async function countRawProfiles(): Promise<number> {
  try {
    const files = await readdir(config.paths.rawAuthorProfiles);
    return files.filter((file) => file.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export function rawProfileName(path: string): string {
  return basename(path, ".json");
}
