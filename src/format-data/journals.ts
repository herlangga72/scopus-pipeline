import { join } from "node:path";
import { config } from "../config.ts";
import { listJsonIds, readJson, writeFileAtomic, writeJsonFile } from "../lib/fsx.ts";
import { toCsv, type Row } from "../lib/csv.ts";
import type { JournalRecord } from "../scopus/types.ts";

export type JournalRow = {
  id: string;
  source_id: string;
  source_title: string;
  publisher: string;
  source_type: string;
  metric_year: string;
  sjr: string;
  snip: string;
  rp: string;
  citescore_year: string;
  citescore_rankings: string;
  citescore_subject_count: string;
  citescore_best_percentile: string;
  citescore_quartile: string;
  citescore_status: string;
};

export type QuartileRow = {
  id: string;
  source_id: string;
  source_title: string;
  publisher: string;
  source_type: string;
  citescore_year: string;
  percentile: string;
  quartile: string;
  subject_count: string;
  sjr: string;
  snip: string;
};

export type CiteScoreRow = {
  id: string;
  source_id: string;
  source_title: string;
  year: string;
  subject_code: string;
  rank: string;
  total_source_count: string;
  subject_percentage: string;
};

export const JOURNAL_COLUMNS: Array<keyof JournalRow> = [
  "id",
  "source_id",
  "source_title",
  "publisher",
  "source_type",
  "metric_year",
  "sjr",
  "snip",
  "rp",
  "citescore_year",
  "citescore_rankings",
  "citescore_subject_count",
  "citescore_best_percentile",
  "citescore_quartile",
  "citescore_status",
];

export const QUARTILE_COLUMNS: Array<keyof QuartileRow> = [
  "id",
  "source_id",
  "source_title",
  "publisher",
  "source_type",
  "citescore_year",
  "percentile",
  "quartile",
  "subject_count",
  "sjr",
  "snip",
];

export const CITESCORE_COLUMNS: Array<keyof CiteScoreRow> = [
  "id",
  "source_id",
  "source_title",
  "year",
  "subject_code",
  "rank",
  "total_source_count",
  "subject_percentage",
];

export function toQuartile(percentile: number | null): string {
  if (percentile === null || !Number.isFinite(percentile)) return "";
  if (percentile >= 75) return "Q1";
  if (percentile >= 50) return "Q2";
  if (percentile >= 25) return "Q3";
  return "Q4";
}

export function flattenJournal(record: JournalRecord): {
  journal: JournalRow;
  citescore: CiteScoreRow[];
  quartile: QuartileRow | null;
} {
  const journals = record.journals ?? {};
  const metrics = journals.metrics ?? [];
  const latestMetricYear = metrics.reduce((latest, metric) => {
    const year = Number(metric.year ?? 0);
    return Number.isFinite(year) && year > latest ? year : latest;
  }, 0);
  const latestMetrics = metrics.filter((metric) => Number(metric.year ?? 0) === latestMetricYear);
  const metricValue = (name: string) =>
    latestMetrics.find((metric) => (metric.name ?? "").toUpperCase() === name)?.value ?? "";

  const scoreRows = (Array.isArray(record.citescore) ? record.citescore : []).map((entry) => ({
    id: record.id,
    source_id: journals.sourceId ?? record.id,
    source_title: journals.sourceTitle ?? "",
    year: entry.year ?? "",
    subject_code: entry.subjectCode ?? "",
    rank: entry.rank ?? "",
    total_source_count: entry.totalSourceCount ?? "",
    subject_percentage: entry.subjectPercentage ?? "",
  }));

  const latestScoreYear = scoreRows.reduce((latest, row) => {
    const year = Number(row.year);
    return Number.isFinite(year) && year > latest ? year : latest;
  }, Number(scoreRows[0]?.year ?? 0));
  const latestScores = scoreRows.filter((row) => Number(row.year) === latestScoreYear);
  const percentiles = latestScores
    .map((row) => Number(row.subject_percentage))
    .filter((value) => Number.isFinite(value));
  const percentile = percentiles.length > 0 ? Math.max(...percentiles) : null;
  const quartile = toQuartile(percentile);

  const journal: JournalRow = {
    id: record.id,
    source_id: journals.sourceId ?? record.id,
    source_title: journals.sourceTitle ?? "",
    publisher: journals.publisher ?? "",
    source_type: journals.sourceType ?? "",
    metric_year: latestMetricYear ? String(latestMetricYear) : "",
    sjr: metricValue("SJR"),
    snip: metricValue("SNIP"),
    rp: metricValue("RP"),
    citescore_year: latestScoreYear ? String(latestScoreYear) : "",
    citescore_rankings: JSON.stringify(latestScores),
    citescore_subject_count: String(latestScores.length),
    citescore_best_percentile: percentile === null ? "" : String(percentile),
    citescore_quartile: quartile,
    citescore_status: Array.isArray(record.citescore) ? "ok" : record.citescore === null ? "missing" : "error",
  };

  const quartileRow: QuartileRow | null = quartile
    ? {
        id: journal.id,
        source_id: journal.source_id,
        source_title: journal.source_title,
        publisher: journal.publisher,
        source_type: journal.source_type,
        citescore_year: journal.citescore_year,
        percentile: journal.citescore_best_percentile,
        quartile,
        subject_count: journal.citescore_subject_count,
        sjr: journal.sjr,
        snip: journal.snip,
      }
    : null;

  return { journal, citescore: scoreRows, quartile: quartileRow };
}

export async function formatJournals(): Promise<{ journals: number; citescore: number; quartiles: number }> {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(config.paths.outDir, { recursive: true }));
  const ids = await listJsonIds(config.paths.rawJournals);
  const journalRows: JournalRow[] = [];
  const citescoreRows: CiteScoreRow[] = [];
  const quartileRows: QuartileRow[] = [];

  for (const id of ids) {
    const record = await readJson<JournalRecord>(join(config.paths.rawJournals, `${id}.json`));
    const { journal, citescore, quartile } = flattenJournal(record);
    journalRows.push(journal);
    citescoreRows.push(...citescore);
    if (quartile) quartileRows.push(quartile);
  }

  await writeFileAtomic(
    join(config.paths.outDir, "journals.csv"),
    toCsv(journalRows as unknown as Row[], JOURNAL_COLUMNS as string[]),
  );
  await writeJsonFile(join(config.paths.outDir, "journals.json"), journalRows);
  await writeFileAtomic(
    join(config.paths.outDir, "journal-citescore.csv"),
    toCsv(citescoreRows as unknown as Row[], CITESCORE_COLUMNS as string[]),
  );
  await writeJsonFile(join(config.paths.outDir, "journal-citescore.json"), citescoreRows);
  await writeFileAtomic(
    join(config.paths.outDir, "journal-quartiles.csv"),
    toCsv(quartileRows as unknown as Row[], QUARTILE_COLUMNS as string[]),
  );
  await writeJsonFile(join(config.paths.outDir, "journal-quartiles.json"), quartileRows);

  return { journals: journalRows.length, citescore: citescoreRows.length, quartiles: quartileRows.length };
}
