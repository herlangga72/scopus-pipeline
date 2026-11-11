import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

export type Row = Record<string, unknown>;

export async function parseCsvFile(path: string): Promise<Row[]> {
  const text = await readFile(path, "utf8");
  return parse(text, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: false,
  }) as Row[];
}

export function toCsv(rows: Row[], columns: string[]): string {
  return stringify(rows, {
    header: true,
    columns,
    quoted: true,
    quoted_empty: false,
    record_delimiter: "\n",
  });
}

export async function readIds(path: string): Promise<string[]> {
  const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  const unique: string[] = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    const id = value.trim().replace(/^"|"$/g, "");
    if (!/^\d{5,}$/.test(id) || seen.has(id)) return;
    seen.add(id);
    unique.push(id);
  };

  if (path.toLowerCase().endsWith(".csv")) {
    const rows = parse(text, {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }) as Row[];
    for (const row of rows) {
      const value = row["Auth-ID"] ?? row["auth-id"] ?? row["scopus_id"] ?? row["scopusId"] ?? row["id"];
      if (typeof value === "string" || typeof value === "number") push(String(value));
    }
    return unique;
  }

  for (const line of text.split(/\r?\n/)) {
    const value = line.split(",")[0] ?? "";
    const cleaned = value.trim();
    if (!cleaned || /scopus.?id/i.test(cleaned) || /auth-?id/i.test(cleaned)) continue;
    push(cleaned);
  }
  return unique;
}

export function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
