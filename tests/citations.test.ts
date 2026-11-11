import { describe, expect, test } from "bun:test";
import {
  buildCitationRequest,
  fetchCitationOverview,
  fetchCitationVariant,
  parseVariants,
  type GatewayPage,
} from "../src/scopus/citations.ts";
import { ScopusAuthError } from "../src/scopus/authors.ts";
import { annualCounts, buildAuthorYearRows, buildDocumentCitationRows, flattenCitationLong } from "../src/format-data/citations.ts";
import { isComplete } from "../src/commands/citations.ts";
import type { CitationOverviewDocument, CitationOverviewRaw } from "../src/scopus/types.ts";

const range = { yearStart: 1996, yearEnd: 2027 };

function doc(id: string, counts: Record<number, number>, extra: Partial<CitationOverviewDocument> = {}): CitationOverviewDocument {
  return {
    id,
    itemTitle: [`Paper ${id}`],
    publicationYear: 2021,
    sourceTitle: "Example Journal",
    issn: ["12345678", "8765432X"],
    volume: "7",
    issue: "1",
    annualReferencedBy: Object.entries(counts).map(([year, count]) => ({
      startYear: Number(year),
      endYear: Number(year),
      referencedByCount: count,
    })),
    ...extra,
  };
}

type Reply = { status: number; body: unknown };

/** Fake page that records POST bodies and replies from a queue (or a function). */
function fakePage(replies: Reply[] | ((body: Record<string, unknown>) => Reply)) {
  const bodies: Array<Record<string, unknown>> = [];
  const page: GatewayPage = {
    url: async () => "https://www.scopus.com/",
    navigate: async () => {},
    evaluate: (async (expression: string) => {
      const match = expression.match(/body: (".*"),\n/);
      const body = JSON.parse(JSON.parse(match![1]!)) as Record<string, unknown>;
      bodies.push(body);
      const reply = typeof replies === "function" ? replies(body) : replies.shift()!;
      return { status: reply.status, text: typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body) };
    }) as GatewayPage["evaluate"],
  };
  return { page, bodies };
}

const fast = { ...range, pageSize: 2, delayMs: 0, retryDelaysMs: [] };

describe("citation request", () => {
  test("sets the right exclusion flag per variant", () => {
    const base = { ...range, skip: 0, amount: 200 };
    expect(buildCitationRequest("1", "all", base)).toMatchObject({
      ids: ["1"],
      yearRangeStart: 1996,
      yearRangeEnd: 2027,
      excludeSelfCitations: false,
      excludeCitationsSelectedAuthor: false,
      excludeBookChapterCitations: false,
      excludeZeros: false,
      sort: "PUBLICATION_DATE_DESC",
      skip: 0,
      amount: 200,
    });
    expect(buildCitationRequest("1", "excl-self-selected", base).excludeCitationsSelectedAuthor).toBe(true);
    expect(buildCitationRequest("1", "excl-self-all", base).excludeSelfCitations).toBe(true);
    expect(buildCitationRequest("1", "excl-book", base).excludeBookChapterCitations).toBe(true);
    expect(buildCitationRequest("1", "excl-book", base).excludeSelfCitations).toBe(false);
  });

  test("parses variant lists", () => {
    expect(parseVariants()).toHaveLength(4);
    expect(parseVariants("all, excl-book,all")).toEqual(["all", "excl-book"]);
    expect(() => parseVariants("nope")).toThrow("unknown citation variant");
  });
});

describe("citation pagination", () => {
  test("pages with skip until totalCount and dedups ids", async () => {
    const { page, bodies } = fakePage([
      { status: 200, body: { totalCount: 5, documents: [doc("a", {}), doc("b", {})] } },
      { status: 200, body: { totalCount: 5, documents: [doc("c", {}), doc("b", {})] } },
      { status: 200, body: { totalCount: 5, documents: [doc("d", {})] } },
    ]);
    const result = await fetchCitationVariant(page, "1", "all", fast);
    expect(bodies.map((body) => body.skip)).toEqual([0, 2, 4]);
    expect(bodies.every((body) => body.amount === 2)).toBe(true);
    expect(result.totalCount).toBe(5);
    expect(result.documents.map((d) => d.id)).toEqual(["a", "b", "c", "d"]);
  });

  test("stops on an empty page", async () => {
    const { page, bodies } = fakePage([
      { status: 200, body: { totalCount: 10, documents: [doc("a", {})] } },
      { status: 200, body: { totalCount: 10, documents: [] } },
    ]);
    const result = await fetchCitationVariant(page, "1", "all", fast);
    expect(bodies).toHaveLength(2);
    expect(result.documents).toHaveLength(1);
  });

  test("handles authors with no documents", async () => {
    const { page } = fakePage([{ status: 200, body: { totalCount: 0, documents: [] } }]);
    const result = await fetchCitationVariant(page, "1", "all", fast);
    expect(result).toEqual({ totalCount: 0, documents: [] });
  });

  test("throws ScopusAuthError on 401", async () => {
    const { page } = fakePage([{ status: 401, body: "" }]);
    await expect(fetchCitationVariant(page, "1", "all", fast)).rejects.toBeInstanceOf(ScopusAuthError);
  });

  test("throws ScopusAuthError when HTML comes back", async () => {
    const { page } = fakePage([{ status: 200, body: "<html>login</html>" }]);
    await expect(fetchCitationVariant(page, "1", "all", fast)).rejects.toBeInstanceOf(ScopusAuthError);
  });

  test("retries 429 then succeeds", async () => {
    const { page, bodies } = fakePage([
      { status: 429, body: "slow down" },
      { status: 200, body: { totalCount: 1, documents: [doc("a", {})] } },
    ]);
    const result = await fetchCitationVariant(page, "1", "all", { ...fast, retryDelaysMs: [0] });
    expect(bodies).toHaveLength(2);
    expect(result.documents).toHaveLength(1);
  });

  test("fetches every variant", async () => {
    const { page, bodies } = fakePage(() => ({ status: 200, body: { totalCount: 1, documents: [doc("a", { 2025: 1 })] } }));
    const raw = await fetchCitationOverview(page, "1", { ...fast });
    expect(Object.keys(raw.variants).sort()).toEqual(["all", "excl-book", "excl-self-all", "excl-self-selected"]);
    expect(bodies).toHaveLength(4);
    expect(raw.yearRangeStart).toBe(1996);
  });
});

const raw: CitationOverviewRaw = {
  authorId: "9001",
  fetchedAt: "2026-11-11T00:00:00.000Z",
  yearRangeStart: 2024,
  yearRangeEnd: 2027,
  variants: {
    all: { totalCount: 2, documents: [doc("a", { 2025: 10, 2026: 5 }), doc("b", { 2026: 3 })] },
    "excl-self-selected": { totalCount: 2, documents: [doc("a", { 2025: 8, 2026: 5 }), doc("b", { 2026: 2 })] },
    "excl-self-all": { totalCount: 2, documents: [doc("a", { 2025: 6, 2026: 4 }), doc("b", { 2026: 4 })] },
    "excl-book": { totalCount: 2, documents: [doc("a", { 2025: 9, 2026: 5 }), doc("b", {})] },
  },
};

describe("citation formatting", () => {
  test("annual counts are sparse year maps", () => {
    expect([...annualCounts(doc("a", { 2025: 2, 2026: 0 })).entries()]).toEqual([
      [2025, 2],
      [2026, 0],
    ]);
  });

  test("long rows only keep positive counts", () => {
    const rows = flattenCitationLong({
      ...raw,
      variants: { all: { totalCount: 1, documents: [doc("a", { 2025: 2, 2026: 0 })] } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scopus_id: "9001",
      document_id: "a",
      title: "Paper a",
      issn: "12345678; 8765432X",
      variant: "all",
      citation_year: 2025,
      citations: 2,
    });
  });

  test("document rows fill missing years with 0 and derive self/book counts", () => {
    const rows = buildDocumentCitationRows(raw, 2024, 2027);
    const a = rows.find((row) => row.document_id === "a")!;
    expect(a.total_all).toBe(15);
    expect(a.total_excl_self_selected).toBe(13);
    expect(a.total_self_selected).toBe(2);
    expect(a.total_self_all).toBe(5);
    expect(a.total_book).toBe(1);
    expect(a.y2024).toBe(0);
    expect(a.y2025).toBe(10);
    expect(a.y2027).toBe(0);

    // excl-self-all (4) > all (3): derived count is clamped at 0
    const b = rows.find((row) => row.document_id === "b")!;
    expect(b.total_self_all).toBe(0);
    expect(b.total_book).toBe(3);
  });

  test("missing variants leave totals blank", () => {
    const rows = buildDocumentCitationRows({ ...raw, variants: { all: raw.variants.all } }, 2024, 2027);
    expect(rows[0]!.total_all).toBe(15);
    expect(rows[0]!.total_excl_book).toBe("");
    expect(rows[0]!.total_book).toBe("");
  });

  test("author-year rows sum across documents", () => {
    const rows = buildAuthorYearRows(raw, "Example, E.");
    expect(rows.map((row) => row.citation_year)).toEqual([2025, 2026]);
    expect(rows[1]).toMatchObject({
      scopus_id: "9001",
      name: "Example, E.",
      citation_year: 2026,
      all: 8,
      excl_self_selected: 7,
      excl_self_all: 8,
      excl_book: 5,
      self_selected: 1,
      self_all: 0,
      book: 3,
    });
  });
});

describe("citation cache", () => {
  test("is complete only with every requested variant and the same range", () => {
    expect(isComplete(raw, ["all", "excl-book"], 2024, 2027)).toBe(true);
    expect(isComplete(raw, ["all"], 1996, 2027)).toBe(false);
    expect(isComplete({ ...raw, variants: { all: raw.variants.all } }, ["all", "excl-book"], 2024, 2027)).toBe(false);
    expect(isComplete(null, ["all"], 2024, 2027)).toBe(false);
  });
});
