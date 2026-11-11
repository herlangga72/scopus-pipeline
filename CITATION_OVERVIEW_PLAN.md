# Implementation Plan — Citation Overview per Dosen

Sumber kebutuhan: `CITATION_OVERVIEW_FEATURE.md`.

## 1. Ringkasan kebutuhan

Untuk **setiap dosen** (Scopus author ID dari seed), ambil **jumlah sitasi per paper per tahun**
dari endpoint Scopus Citation Overview, untuk beberapa varian filter sitasi:

| Varian (`variant`) | `excludeSelfCitations` | `excludeCitationsSelectedAuthor` | `excludeBookChapterCitations` | Arti |
|---|---|---|---|---|
| `all` | false | false | false | Semua sitasi (baseline) |
| `excl-self-selected` | false | **true** | false | Tanpa self-citation dari dosen yang dipilih |
| `excl-self-all` | **true** | false | false | Tanpa self-citation dari semua co-author |
| `excl-book` | false | false | **true** | Tanpa sitasi dari book/book chapter |

Dari varian di atas, jumlah *self citation* dan *book citation* bisa diturunkan per paper per tahun:

- `self_selected = all − excl-self-selected`
- `self_all      = all − excl-self-all`
- `book          = all − excl-book`

Parameter tetap:

- `yearRangeStart = 1996` (batas tertua data sitasi Scopus)
- `yearRangeEnd = tahun berjalan + 1` (contoh respons sudah memuat bucket 2027 — sitasi dari paper *in press*/terbit lebih awal). Bisa dioverride via CLI.
- `excludeZeros = false` (semua paper ikut, termasuk yang belum pernah disitasi)
- `sort = PUBLICATION_DATE_DESC`
- Pagination: `skip` / `amount = 200`, ulangi sampai `skip >= totalCount`.

## 2. Endpoint

```
POST https://www.scopus.com/gateway/citation-overview/authors/citations
Content-Type: application/json;charset=UTF-8
Accept: application/json

{
  "ids": ["<authorId>"],
  "yearRangeStart": 1996,
  "yearRangeEnd": 2027,
  "excludeSelfCitations": false,
  "excludeBookChapterCitations": false,
  "excludeCitationsSelectedAuthor": false,
  "excludeZeros": false,
  "sort": "PUBLICATION_DATE_DESC",
  "skip": 0,
  "amount": 200
}
```

Respons: `{ documents: CitationOverviewDocument[], totalCount: number }`, dengan tiap dokumen memuat
`id`, `itemTitle[]`, `publicationYear`, `sourceTitle`, `issn[]`, `volume`, `issue`, dan
`annualReferencedBy[] = { startYear, endYear, referencedByCount }`.

Catatan penting:

- `annualReferencedBy` **sparse** — tahun dengan 0 sitasi tidak muncul. Formatter harus mengisi 0 sendiri bila butuh format lebar.
- Request dilakukan **dari dalam tab Chrome yang sudah login** (same-origin `fetch` lewat CDP, seperti `graphql()` di `src/scopus/authors.ts`). Cookie, `newrelic`, `traceparent`, dll. pada contoh **tidak** dipakai/di-hardcode — browser mengirim cookie sesi sendiri.
- Header `Referer` mungkin diperiksa gateway. Jika request ditolak, navigasikan dulu ke
  `/pages/citationOverview?authorsIds=<id>&origin=AuthorProfile` sebelum fetch (lihat Risiko).

## 3. Desain

Mengikuti pola pipeline yang sudah ada: **fetch → cache raw JSON → format-data → JSON + CSV**.
File cache yang sudah ada = langkah selesai; `--force` untuk refetch.

### 3.1 Struktur data cache

```
data/raw/citation-overview/<authorId>.json
```

Satu file per dosen, berisi semua varian sekaligus, sehingga "selesai" berarti semua varian lengkap:

```jsonc
{
  "authorId": "57216633039",
  "fetchedAt": "2026-11-11T10:00:00.000Z",
  "yearRangeStart": 1996,
  "yearRangeEnd": 2027,
  "variants": {
    "all":                { "totalCount": 33, "documents": [ /* raw documents */ ] },
    "excl-self-selected": { "totalCount": 33, "documents": [ ... ] },
    "excl-self-all":      { "totalCount": 33, "documents": [ ... ] },
    "excl-book":          { "totalCount": 33, "documents": [ ... ] }
  }
}
```

Dokumen raw disimpan apa adanya (tidak dinormalisasi) supaya formatter bisa diubah tanpa refetch.

### 3.2 Output (`data/out/`)

1. **`citation-overview-long.csv` / `.json`** — format panjang, paling mudah dianalisis (pivot di Excel/pandas):

   | scopus_id | document_id | title | pub_year | source_title | issn | volume | issue | variant | citation_year | citations |
   |---|---|---|---|---|---|---|---|---|---|---|

   Hanya baris dengan `citations > 0` (sparse), agar ukuran file wajar.

2. **`citation-overview-documents.csv`** — satu baris per (dosen, paper), kolom turunan per tahun:

   `scopus_id, document_id, title, pub_year, source_title, total_all, total_excl_self_selected, total_excl_self_all, total_excl_book, total_self_selected, total_self_all, total_book, y1996 … y2027`

   Kolom `yYYYY` berisi sitasi varian `all`; nilai kosong diisi `0`.

3. **`citation-overview-authors.csv`** — ringkasan per dosen per tahun:

   `scopus_id, name, citation_year, all, excl_self_selected, excl_self_all, excl_book, self_selected, self_all, book`

   (`name` di-join dari `author-profiles` bila ada.)

## 4. Langkah implementasi

### Langkah 1 — Types (`src/scopus/types.ts`)

Tambahkan:

```ts
export type CitationVariant = "all" | "excl-self-selected" | "excl-self-all" | "excl-book";

export type CitationOverviewAnnual = { startYear: number; endYear: number; referencedByCount: number };

export type CitationOverviewDocument = {
  id: string;
  itemTitle?: string[];
  publicationYear?: number;
  sourceTitle?: string;
  issn?: string[];
  volume?: string;
  issue?: string;
  annualReferencedBy?: CitationOverviewAnnual[];
};

export type CitationOverviewPage = { documents?: CitationOverviewDocument[]; totalCount?: number };

export type CitationOverviewRaw = {
  authorId: string;
  fetchedAt: string;
  yearRangeStart: number;
  yearRangeEnd: number;
  variants: Record<CitationVariant, { totalCount: number; documents: CitationOverviewDocument[] }>;
};
```

### Langkah 2 — Config (`src/config.ts`)

- `paths.rawCitationOverview = resolve(dataDir, "raw/citation-overview")`
- `scopus.citationYearStart = num("SCOPUS_CITATION_YEAR_START", 1996)`
- `scopus.citationYearEnd = num("SCOPUS_CITATION_YEAR_END", new Date().getFullYear() + 1)`
- `scopus.citationPageSize = num("SCOPUS_CITATION_PAGE_SIZE", 200)`

Tambahkan variabel env baru ke `.env.example`.

### Langkah 3 — Fetcher (`src/scopus/citations.ts`, baru)

- `CITATION_VARIANTS: Record<CitationVariant, { excludeSelfCitations; excludeCitationsSelectedAuthor; excludeBookChapterCitations }>` — tabel di bagian 1.
- `buildCitationRequest(authorId, variant, { yearStart, yearEnd, skip, amount })` → body JSON (fungsi murni, mudah dites).
- `postGatewayJson<T>(page, url, body)` — `page.evaluate` dengan `fetch(..., { method: "POST" })`, pola sama seperti `graphql()`:
  - 401/403 atau respons HTML → `ScopusAuthError` (hentikan seluruh run).
  - 429/5xx → retry dengan backoff (mis. 3x: 2s, 5s, 10s).
  - status lain → `Error` (dicatat gagal untuk dosen itu, lanjut ke dosen berikutnya).
  - Pertimbangkan memindahkan helper POST ini ke modul bersama (mis. `src/scopus/gateway.ts`) dan memakai ulang di `graphql()`; opsional, bukan syarat fitur.
- `fetchCitationVariant(page, authorId, variant, range)`:
  - loop `skip = 0; skip < totalCount; skip += documents.length`, jeda `config.scopus.requestDelayMs` antar halaman;
  - berhenti juga bila halaman kosong (guard infinite loop);
  - dedup dokumen berdasarkan `id`;
  - peringatan (`log.warn`) bila jumlah akhir ≠ `totalCount`.
- `fetchCitationOverview(page, authorId, range): Promise<CitationOverviewRaw>` — jalankan keempat varian berurutan (tidak paralel, untuk menghindari rate limit).

### Langkah 4 — Command (`src/commands/citations.ts`, baru)

`runCitationOverview(options)` dengan pola yang sama seperti `runAuthorDocuments`:

1. Resolve author ID (`--ids` / `--seed` / `--from-profiles` / seed default) — pakai ulang `resolveAuthorIds` dan `applyLimit` dari `src/commands/authors.ts` (export, atau pindahkan ke `src/lib/ids.ts`).
2. Skip ID yang sudah punya file cache, kecuali `--force`.
3. `withPage(...)` → `ensureScopusPage` → untuk tiap dosen: `fetchCitationOverview` → `writeJsonFile(rawCitationOverview/<id>.json)` → `Progress.tick`.
4. Cache hanya ditulis setelah **semua varian** berhasil (tidak ada file setengah jadi).
5. Setelah selesai, panggil `formatCitations()`.

Opsi tambahan: `--year-start <n>`, `--year-end <n>`, `--variants <list>` (default semua; berguna untuk debug).

### Langkah 5 — Formatter (`src/format-data/citations.ts`, baru)

- `flattenCitationLong(raw): CitationLongRow[]`
- `buildDocumentCitationRows(raw, yearStart, yearEnd): DocumentCitationRow[]` — gabungkan varian per `document_id`, isi tahun kosong dengan 0, hitung kolom turunan (`self_*`, `book`) dengan `Math.max(0, a − b)` untuk berjaga terhadap inkonsistensi data.
- `buildAuthorYearRows(raw, profileNames)`
- `formatCitations(): Promise<{ authors; documents; rows }>` — baca semua file cache, tulis tiga output pada bagian 3.2 dengan `toCsv` + `writeFileAtomic` / `writeJsonFile`.
- Bucket tahun diambil dari `startYear` (Scopus mengirim `startYear === endYear`); jika suatu saat berbeda, log warning.

### Langkah 6 — CLI (`src/cli.ts`) & scripts (`package.json`)

- Subcommand baru:
  ```
  scopus citations overview [--ids|--seed|--from-profiles] [-f] [-n] [--year-start] [--year-end] [--variants] [--no-launch] [--headless]
  ```
- Flag top-level `--citations` (ikut dijalankan oleh `--all`, setelah `--author`).
- `format-data citations` dan masukkan `formatCitations` ke `runFormatAll`.
- Scripts:
  ```json
  "citations:overview": "bun run src/cli.ts citations overview",
  "format-data:citations": "bun run src/cli.ts format-data citations"
  ```

### Langkah 7 — Tests (`tests/citations.test.ts`, baru)

Pakai fixture JSON kecil berbentuk contoh respons di spec (data fiktif, bukan data asli):

- `buildCitationRequest` menghasilkan flag yang benar untuk tiap varian, serta `skip`/`amount` yang benar.
- Logika pagination: mock `page.evaluate` yang mengembalikan 2 halaman (200 + 33) → total 233 dokumen, berhenti dengan benar; halaman kosong menghentikan loop; dedup `id`.
- 401 → `ScopusAuthError`.
- `buildDocumentCitationRows`: tahun sparse terisi 0, kolom turunan benar, nilai negatif dijepit ke 0.
- `flattenCitationLong`: hanya baris `citations > 0`.

Jalankan `bun test` dan `bun run check`.

### Langkah 8 — Dokumentasi

- Tambahkan bagian "Citation overview" di `README.md` (perintah, output, arti varian).
- Update diagram alur bila perlu.

## 5. Verifikasi manual

1. `bun run doctor --deep` — sesi Scopus aktif.
2. `bun run citations:overview --ids <file berisi 1 ID> --verbose`
3. Bandingkan dengan halaman web `https://www.scopus.com/pages/citationOverview?authorsIds=<id>&origin=AuthorProfile`:
   - `totalCount` sama dengan jumlah dokumen di halaman;
   - total per tahun untuk varian `all` sama dengan baris total di tabel web;
   - centang filter "exclude self citations…" di web → angka sama dengan varian terkait.
4. Uji dosen dengan > 200 dokumen untuk memastikan pagination.
5. Jalankan untuk seluruh seed, cek `data/out/citation-overview-*.csv`.

## 6. Risiko & pertanyaan terbuka

| # | Hal | Mitigasi / keputusan yang perlu dikonfirmasi |
|---|---|---|
| 1 | Gateway mungkin mewajibkan `Referer` dari halaman citationOverview atau token Cloudflare (`cf_clearance`) | Coba fetch dari halaman Scopus biasa dulu; jika 403, navigasi ke halaman citationOverview sebelum fetch. |
| 2 | Rate limit / Cloudflare challenge pada ratusan dosen × 4 varian | Jeda antar request, backoff 429, eksekusi berurutan, cache per dosen sehingga run bisa dilanjutkan. |
| 3 | Batas `amount` maksimum belum diketahui | Default 200 (sesuai contoh); bisa diturunkan via env. |
| 4 | Apakah `yearRangeEnd` > tahun berjalan + 1 ditolak? | Default `tahun + 1` (2027); dapat dioverride. |
| 5 | Kombinasi filter (mis. exclude self **dan** book sekaligus) | Plan ini mengambil 4 varian independen. Jika dibutuhkan kombinasi, tinggal tambah entri di `CITATION_VARIANTS`. **Perlu konfirmasi.** |
| 6 | Apakah perlu ID banyak dosen sekaligus di `ids` (satu request)? | Tidak — hasilnya digabung tanpa atribusi per dosen. Tetap 1 dosen per request. |
| 7 | `CITATION_OVERVIEW_FEATURE.md` berisi cookie sesi asli (`SCSessionID`, `JSESSIONID`, `cf_clearance`, dll.) dan file ini belum di-commit | Hapus/samarkan cookie sebelum file di-commit. Kode tidak boleh memakai cookie tersebut. |

## 7. Daftar file

| File | Status |
|---|---|
| `src/scopus/types.ts` | ubah — tipe citation overview |
| `src/config.ts`, `.env.example` | ubah — path & parameter tahun |
| `src/scopus/citations.ts` | **baru** — fetcher + pagination + varian |
| `src/commands/citations.ts` | **baru** — orkestrasi per dosen + cache |
| `src/commands/authors.ts` | ubah — export `resolveAuthorIds` / `applyLimit` |
| `src/format-data/citations.ts` | **baru** — output long / documents / authors |
| `src/commands/format-data.ts` | ubah — target `citations` |
| `src/cli.ts`, `package.json` | ubah — command, flag, scripts |
| `tests/citations.test.ts` | **baru** |
| `README.md` | ubah — dokumentasi |
