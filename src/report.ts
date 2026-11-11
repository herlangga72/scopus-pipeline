import { join } from "node:path";
import { config } from "./config.ts";
import { toCsv, type Row } from "./lib/csv.ts";
import { writeFileAtomic, writeJsonFile } from "./lib/fsx.ts";
import { loadProfileRows } from "./format-data/authors.ts";
import type { AuthorProfileRow } from "./scopus/types.ts";

export type AffiliationSummary = {
  total: number;
  ok: number;
  home: number;
  other: number;
  blank: number;
  notFound: number;
  withEmail: number;
  withoutEmail: number;
};

const HOME_COLUMNS = [
  "username",
  "username_local",
  "Name",
  "scopus_id",
  "affiliation",
  "city",
  "state",
  "country",
  "orcid",
  "documents",
  "citations",
  "h_index",
  "affiliation_category",
];

const USERNAME_COLUMNS = ["username", "username_local", "Name", "scopus_id", "affiliation", "status"];

function md(value: string): string {
  return value.replace(/\|/g, "\\|");
}

export async function runAffiliationReport(): Promise<{ summary: AffiliationSummary; reportPath: string }> {
  const { rows } = await loadProfileRows();
  const homePattern = new RegExp(config.report.homeInstitutionPattern, "i");
  const summary: AffiliationSummary = {
    total: rows.length,
    ok: 0,
    home: 0,
    other: 0,
    blank: 0,
    notFound: 0,
    withEmail: 0,
    withoutEmail: 0,
  };

  const nonHome: Array<AuthorProfileRow & { affiliation_category: string }> = [];
  const usernames: Row[] = [];

  for (const row of rows) {
    if (row.status === "ok") {
      summary.ok += 1;
      if (row.username) summary.withEmail += 1;
      else summary.withoutEmail += 1;
      if (!row.affiliation) {
        summary.blank += 1;
        nonHome.push({ ...row, affiliation_category: "blank" });
      } else if (homePattern.test(row.affiliation)) {
        summary.home += 1;
      } else {
        summary.other += 1;
        nonHome.push({ ...row, affiliation_category: "other" });
      }
      usernames.push({
        username: row.username,
        username_local: row.username_local,
        Name: row.Name,
        scopus_id: row.scopus_id,
        affiliation: row.affiliation,
        status: row.status,
      });
    } else if (row.status === "not_found") {
      summary.notFound += 1;
    } else {
      summary.blank += 1;
    }
  }

  await writeFileAtomic(
    join(config.paths.outDir, "scopus-non-home-affiliations.csv"),
    toCsv(nonHome as unknown as Row[], HOME_COLUMNS),
  );
  await writeFileAtomic(
    join(config.paths.outDir, "scopus-usernames.csv"),
    toCsv(usernames, USERNAME_COLUMNS),
  );

  const nonHomeTable = nonHome
    .map(
      (row) =>
        `| ${md(row.username || "-")} | ${md(row.Name || "-")} | ${row.scopus_id} | ${md(row.affiliation || "(blank)")} | ${md([row.city, row.country].filter(Boolean).join(", ") || "-")} |`,
    )
    .join("\n");

  const report = `# Scopus Affiliation Report

- Profiles checked: **${summary.total}**
- Profiles found: **${summary.ok}**
- Current affiliation home institution: **${summary.home}**
- Current affiliation other institution: **${summary.other}**
- Blank affiliation: **${summary.blank}**
- Not found on Scopus: **${summary.notFound}**
- Email / username available: **${summary.withEmail}** (${summary.withoutEmail} blank)

## Files

- \`scopus-usernames.csv\` - username, name, id, affiliation
- \`scopus-non-home-affiliations.csv\` - full detail for non-home or blank affiliations
- \`author-profiles.csv\` - all flattened profile data
- \`author-profiles.json\` - same data as JSON

## Affiliations outside the home institution

| username | Name | scopus_id | affiliation | city, country |
|---|---|---|---|---|
${nonHomeTable || "| - | - | - | - | - |"}
`;

  const reportPath = join(config.paths.outDir, "scopus-affiliation-report.md");
  await writeFileAtomic(reportPath, report);
  await writeJsonFile(join(config.paths.outDir, "scopus-affiliation-summary.json"), { summary, nonHome });
  return { summary, reportPath };
}
