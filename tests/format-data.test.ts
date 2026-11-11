import { describe, expect, test } from "bun:test";
import { flattenProfile } from "../src/scopus/authors.ts";
import { flattenDocument } from "../src/format-data/authors.ts";
import { flattenJournal, toQuartile } from "../src/format-data/journals.ts";
import { mergeDocumentResponses, normalizeDocumentItem } from "../src/scopus/documents.ts";
import type { JournalRecord, ScopusAuthorProfile } from "../src/scopus/types.ts";

describe("author profiles", () => {
  test("flattens a normal profile", () => {
    const profile: ScopusAuthorProfile = {
      id: "90000000001",
      profile: {
        preferredName: "Example, E.",
        preferredFirstName: "Example",
        preferredLastName: "E.",
        orcId: "0000-0001-2345-6789",
        emailAddress: "author@example.org",
        currentInstitution: { name: "Example University", city: "Example City", country: "Indonesia" },
        institutionHistory: [{ name: "Example U", city: "Example City" }],
      },
      metrics: { documentCount: 12, citationCount: 40, citedByCount: 38, hindex: 4, coAuthorsCount: 30 },
    };

    const row = flattenProfile("90000000001", profile);
    expect(row.status).toBe("ok");
    expect(row.username).toBe("author@example.org");
    expect(row.username_local).toBe("author");
    expect(row.documents).toBe("12");
    expect(row.institution_history).toContain("Example U | Example City");
  });

  test("handles missing profile", () => {
    const row = flattenProfile("1", null);
    expect(row.status).toBe("not_found");
    expect(row.Name).toBe("");
  });
});

describe("documents", () => {
  const item = {
    eid: "2-s2.0-1",
    scopusId: "1",
    doi: "10.1/x",
    title: "A paper",
    pubYear: "2024",
    documentType: "Article",
    citations: { count: 3 },
    references: { count: 9 },
    totalAuthors: 2,
    authors: [
      { authorId: "1", preferredName: { full: "Doe, J." } },
      { authorId: "2", preferredName: { full: "Roe, R." } },
    ],
    subjectAreas: [{ code: 31, displayName: "Physics" }],
    source: { id: "123", title: "Journal", publisher: "Pub", issn: "1234-5678", sourceType: "j" },
    abstractText: ["Hello", "world"],
  };

  test("flattens a document", () => {
    const row = flattenDocument("99", item);
    expect(row.scopus_id).toBe("99");
    expect(row.authors).toBe("Doe, J.; Roe, R.");
    expect(row.citations).toBe("3");
    expect(row.abstract).toBe("Hello world");
  });

  test("merges and dedupes document responses", () => {
    const merged = mergeDocumentResponses([
      { metadata: { totalCount: 2, itemCount: 1 }, items: [item] },
      { metadata: { totalCount: 2, itemCount: 1 }, items: [{ ...item, title: "Duplicate" }] },
    ]);
    expect(merged?.items?.length).toBe(1);
    expect(merged?.metadata?.itemCount).toBe(1);
  });

  test("normalizes the current author-profile document shape", () => {
    const listItem = {
      documentId: "90000000002",
      titles: ["A title"],
      publicationDate: "2024-03-01",
      documentType: "CONFERENCE_PAPER",
      citationCount: 4,
      totalAuthors: 2,
      authors: [
        { authorId: "1", preferredFirstName: "A", preferredLastName: "One", initials: "A." },
        { authorId: "2", preferredFirstName: "B", preferredLastName: "Two", initials: "B." },
      ],
      source: { id: "90000000003", title: "Proceedings", sourceType: "CONFERENCE_PROCEEDING", issn: ["1234-5678"] },
    };
    const detail = {
      eid: "2-s2.0-90000000002",
      abstract: ["Abstract text"],
      publicationYear: "2024",
      doi: "10.1/x",
      authorCount: "2",
      source: { id: "90000000003", title: "Proceedings", publisher: "Pub", type: "p", subjectAreaCodes: ["1706", "2208"] },
    };

    const row = normalizeDocumentItem(listItem, detail);
    expect(row.eid).toBe("2-s2.0-90000000002");
    expect(row.scopusId).toBe("90000000002");
    expect(row.pubYear).toBe("2024");
    expect(row.abstractText?.[0]).toBe("Abstract text");
    expect(row.source?.id).toBe("90000000003");
    expect(row.source?.publisher).toBe("Pub");
    expect(row.subjectAreas?.length).toBe(2);
    expect(row.authors?.[0]?.preferredName?.full).toBe("A One");
  });
});

describe("journals", () => {
  test("selects the latest metrics and handles missing citescore", () => {
    const record: JournalRecord = {
      id: "90000000004",
      journals: {
        sourceId: "90000000004",
        sourceTitle: "Proceedings",
        publisher: "Example Publisher",
        sourceType: "p",
        metrics: [
          { name: "SJR", value: "0.1", year: "2023" },
          { name: "SJR", value: "0.2", year: "2024" },
          { name: "SNIP", value: "0.3", year: "2024" },
        ],
      },
      citescore: null,
    };
    const { journal, citescore } = flattenJournal(record);
    expect(journal.sjr).toBe("0.2");
    expect(journal.metric_year).toBe("2024");
    expect(journal.citescore_status).toBe("missing");
    expect(citescore.length).toBe(0);
  });

  test("marks gateway errors", () => {
    const record: JournalRecord = {
      id: "90000000004",
      journals: { sourceId: "90000000004", sourceTitle: "X" },
      citescore: { code: "INTERNAL_SERVER_ERROR" },
    };
    const { journal } = flattenJournal(record);
    expect(journal.citescore_status).toBe("error");
  });

  test("maps CiteScore percentiles to quartiles", () => {
    expect(toQuartile(82)).toBe("Q1");
    expect(toQuartile(75)).toBe("Q1");
    expect(toQuartile(60)).toBe("Q2");
    expect(toQuartile(25)).toBe("Q3");
    expect(toQuartile(10)).toBe("Q4");
    expect(toQuartile(null)).toBe("");
  });

  test("builds a quartile row from the best subject percentile", () => {
    const record: JournalRecord = {
      id: "40067",
      journals: { sourceId: "40067", sourceTitle: "Proceedings", publisher: "SPIE", sourceType: "p" },
      citescore: [
        { subjectCode: "3105", subjectPercentage: "82", year: "2024", rank: "10", totalSourceCount: "100" },
        { subjectCode: "2208", subjectPercentage: "40", year: "2024", rank: "60", totalSourceCount: "100" },
      ],
    };
    const { journal, quartile } = flattenJournal(record);
    expect(journal.citescore_best_percentile).toBe("82");
    expect(journal.citescore_quartile).toBe("Q1");
    expect(quartile?.quartile).toBe("Q1");
    expect(quartile?.source_title).toBe("Proceedings");
  });
});
