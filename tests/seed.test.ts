import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { readIds } from "../src/lib/csv.ts";
import { __test } from "../src/commands/authors.ts";

describe("seed input", () => {
  test("parses the default seed CSV", async () => {
    const ids = await readIds(config.paths.seedAuthorIds);
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => /^\d+$/.test(id))).toBe(true);
    expect(ids[0]).toBe("90000000001");
  });

  test("accepts a custom seed path through the author command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scopus-seed-"));
    const path = join(dir, "seed.csv");
    await writeFile(path, "Auth-ID,Name\n12345678901,A\n12345678901,B\n12345678902,C\n");
    try {
      const ids = await __test.resolveAuthorIds({ seed: path });
      expect(ids).toEqual(["12345678901", "12345678902"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
