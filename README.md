# veroptima-qa-fixture-files

The **A1 unblock pack** for the `qa-expert` fixture-pack family: generic, locale-neutral, file-output generators. Implements [`@qa-expert/fixture-pack-contract`](../../qa-expert-agent-first-try/packages/contracts/fixture-pack) v0.1.0.

## Why this pack exists

ADR-0014's original generator contract returned **strings**. The [`fixture-pack-enrichment` spec](../../qa-expert-agent-first-try/docs/specs/fixture-pack-enrichment/spec.md) — A1 — extended it with `FileFixture` so a generator can produce bytes the agent's `upload` step attaches. The first live block this unblocks is `PLAN-AE-FLOW-URBANO` *Finalizar* — a mandatory PDF attachment with no string answer.

This pack ships the file-shaped primitives that block was missing. They are **domain-agnostic** (no locale), so they live in their own pack, not inside `br-gov` or `geo`.

## Kinds

| kind | outputs | mediaType | params | locales |
|---|---|---|---|---|
| `pdf-doc` | file | `application/pdf` | `{ pages?: number, text?: string }` (defaults `1` / `"Documento"`) | — |
| `image-png` | file | `image/png` | `{ width?: number, height?: number, label?: string }` (defaults `16x16` / `""`) | — |
| `image-jpg` | file | `image/jpeg` | `{ width?: number, height?: number, label?: string }` (defaults `16x16` / `""`) | — |
| `zip` | file | `application/zip` | `{ entries: Array<{ name: string, content: string }> }` | — |

## Wrap-vs-author choice (per A4 of the spec)

A4 says: *wrap a library when the format is a solved commodity and bugs are loud; author from scratch when correctness is the moat and bugs are silent.* This pack's targets are all "solved-commodity, loud-failure" container formats — no locale, no business rule. So the wrap policy is:

| kind | choice | reasoning |
|---|---|---|
| `pdf-doc` | **wrap `pdf-lib@1.17.1`** | PDF byte-format is a 1000-page solved commodity. `pdf-lib` is mature, MIT-licensed, browser+node compatible, and writes a clean PDF 1.7. The only price was making it deterministic (see below). |
| `image-png` | **author from scratch** | The PNG spec is short and the encoder is ~60 lines (RGBA raster + filter byte + zlib deflate + four chunks + CRC). `pngjs` is a binary `Node Buffer` dep and a bigger surface than the encoder itself. Authoring it: smaller dep tree, fewer determinism foot-guns. |
| `image-jpg` | **author from scratch** | JPEG is bigger (Huffman + DCT) but still tractable, and `sharp` is a native binary we'd have to ship per-platform. We use the standard JFIF Annex K Huffman tables + standard quantization tables (quality ~50), 4:4:4 sampling, no thumbnail, no `Exif`. No timestamps. |
| `zip` | **wrap `jszip@3.10.1`** | ZIP is a tiny format but jszip handles central-directory bookkeeping cleanly; the dep is pure-JS, no native binding. Determinism cost was just `date: new Date(0)` + pinned `platform: "UNIX"` + `compression: "STORE"`. |

A4 guards observed:
1. **Pin transitively + lock.** `package.json` uses exact pins (no `^`/`~`) for every dep. A pack-lockfile will be added when the lockfile-format spec (A6 of the spec) lands.
2. **Force the seed through.** `pdf-lib` is driven only by params (text + page count) + the constant trailer-`/ID` we generate from `ctx.seed` via a seeded PRNG; `jszip` is purely a packer with no RNG; the PNG and JPEG encoders run a sfc32 PRNG seeded from `fnv1a32(ctx.seed)`.
3. **Sandbox-only.** This pack only opens files via the `upload` step — no I/O outside the runtime-materialised temp dir.

## Determinism (LOAD-BEARING)

Same `(seed, params, locale)` → byte-identical `bytes`. Cross-call replay tests live in `src/__tests__/index.test.ts` and **must pass** for the pack to ship.

What we had to do per kind:

- **`pdf-doc`** — pdf-lib bakes a CreationDate, a ModificationDate, a Producer string, and a random `/ID` array in the trailer. Every one of these we override:
  - `PDFDocument.create({ updateMetadata: false })` — turns off the auto-updating of ModDate on save.
  - `setCreationDate(new Date(0))`, `setModificationDate(new Date(0))` — pin the timestamps.
  - `setProducer("veroptima-qa-fixture-files")`, `setCreator(...)`, `setTitle("seed:<seed>")` — pin the strings.
  - Patch `doc.context.trailerInfo.ID` to a deterministic 32-byte hex pair derived from `ctx.seed` via our sfc32 PRNG. Without this, two calls' `/ID` arrays differ (pdf-lib seeds it from `Math.random()` at save time).
  - `doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false })` — use cross-reference table (not object streams) for a stable byte layout, and disable form-appearance refresh.
  - **Result:** `pdfDocDeterministic: true`. Two calls at the same seed produce byte-identical PDFs (verified by test).
- **`image-png`** — pure pixel data → zlib deflate. Pinned `level: 9`. No timestamps in PNG, no `tIME` chunk, no `tEXt` chunks. Deterministic by construction.
- **`image-jpg`** — fixed JFIF header, fixed Huffman tables, fixed quantization tables, no thumbnail, no Exif. RGB→YCbCr → 8×8 forward DCT → quantize → zigzag → Huffman-coded entropy. Deterministic by construction.
- **`zip`** — jszip + `date: new Date(0)` per entry + `compression: "STORE"` + `platform: "UNIX"`. Output bytes depend only on `params.entries`; the test asserts this and asserts identical bytes across different seeds (the zip is a pure container).

## Use

```ts
import pack, { pdfDocGenerator } from "veroptima-qa-fixture-files";

const result = await pdfDocGenerator.generate(
  { pages: 1, text: "Documento" },
  { seed: "run-42", logger: { debug(){}, info(){}, warn(){}, error(){} } },
);
// result.bytes — Uint8Array; the runtime materialises to /tmp/.../documento.pdf
// and the agent's `upload` step attaches that path.
```

## Verification

```bash
bun install
bun x tsc --noEmit
bun test
```

All three must be green. The five cross-call determinism tests (`DETERMINISM: ...`) are non-negotiable.

## License

MIT. See `LICENSE`.
