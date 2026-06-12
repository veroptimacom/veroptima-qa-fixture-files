/**
 * veroptima-qa-fixture-files — A1 unblock pack.
 *
 * Generic, locale-neutral, file-output fixture generators (`pdf-doc`,
 * `image-jpg`, `image-png`, `zip`) for the qa-expert agent. Implements
 * `@qa-expert/fixture-pack-contract` v0.1.0.
 *
 * Why this pack exists: ADR-0014's original fixture-generator contract was
 * string-valued. A1 of the fixture-pack-enrichment spec extended that contract
 * with `FileFixture` so a generator can produce bytes the `upload` step
 * attaches. The first live block this unblocks is `PLAN-AE-FLOW-URBANO`
 * Finalizar — a mandatory document attachment with no string answer.
 *
 * Determinism (LOAD-BEARING per A4 guard #2):
 *   same (seed, params, locale)  →  byte-identical `bytes`.
 *
 * - All randomness is driven by `ctx.seed` through a seeded PRNG (sfc32, with
 *   the 32-bit state derived from `ctx.seed` via FNV-1a). We never call
 *   `Math.random()`.
 * - For `pdf-doc` we wrap `pdf-lib` and explicitly neutralise every source of
 *   non-determinism it embeds: `updateMetadata: false`, fixed creation and
 *   modification dates (epoch), fixed producer/creator/title, and
 *   `useObjectStreams: false` on save. We additionally regenerate the trailer
 *   `/ID` array deterministically (pdf-lib seeds it from random by default;
 *   even though pdf-lib's serialization is otherwise stable, the `/ID` entry
 *   varies per call). See the README for the full audit.
 * - For `image-png` we hand-roll the encoder (uncompressed-style: chunked +
 *   zlib deflate). zlib's deflate is deterministic given identical input.
 * - For `image-jpg` we hand-roll a minimal baseline JPEG encoder with fixed
 *   quantization tables (the standard ones from Annex K). No timestamps.
 * - For `zip` we wrap `jszip` with `date: new Date(0)` on every entry and a
 *   pinned platform field; jszip's stream output is then stable.
 *
 * Every kind ships a cross-call replay test asserting bytewise equality. See
 * `src/__tests__/index.test.ts`.
 */
import {
  PDFDocument,
  PDFHexString,
  PDFArray,
  StandardFonts,
} from "pdf-lib";
import JSZip from "jszip";
import { z } from "zod";
import {
  defineFixturePack,
  FixturePackManifestSchema,
  type FileFixture,
  type FixturePack,
  type Generator,
  type GenContext,
} from "@qa-expert/fixture-pack-contract";
import manifestJson from "../fixture-pack.json" with { type: "json" };

// ── Seeded PRNG ──────────────────────────────────────────────────────────────

/** FNV-1a 32-bit over a UTF-8 string. Stable across runtimes. */
function fnv1a32(str: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * sfc32 PRNG — fast, deterministic, well-distributed 32-bit output. We
 * derive the four 32-bit state words from `seed` via FNV-1a over four
 * salted variants, so two distinct seed strings give distinct streams.
 */
function makePrng(seed: string): {
  next: () => number;
  /** Uniform integer in [0, 256). */
  nextByte: () => number;
} {
  let a = fnv1a32(seed + "|a") >>> 0;
  let b = fnv1a32(seed + "|b") >>> 0;
  let c = fnv1a32(seed + "|c") >>> 0;
  let d = fnv1a32(seed + "|d") >>> 0;
  // sfc32 needs a non-zero state; if all four collapse to zero we perturb.
  if ((a | b | c | d) === 0) {
    a = 1;
  }
  const next = (): number => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  const nextByte = (): number => next() & 0xff;
  return { next, nextByte };
}

// ── Param schemas ────────────────────────────────────────────────────────────

export const PdfDocParamsSchema = z
  .object({
    pages: z.number().int().positive().max(1024).optional(),
    text: z.string().optional(),
  })
  .strict();
export type PdfDocParams = z.infer<typeof PdfDocParamsSchema>;

export const ImageParamsSchema = z
  .object({
    width: z.number().int().positive().max(2048).optional(),
    height: z.number().int().positive().max(2048).optional(),
    label: z.string().optional(),
  })
  .strict();
export type ImageParams = z.infer<typeof ImageParamsSchema>;

export const ZipEntrySchema = z
  .object({
    name: z.string().min(1),
    content: z.string(),
  })
  .strict();
export const ZipParamsSchema = z
  .object({
    entries: z.array(ZipEntrySchema).min(1),
  })
  .strict();
export type ZipParams = z.infer<typeof ZipParamsSchema>;

// ── pdf-doc ──────────────────────────────────────────────────────────────────

const PDF_PRODUCER = "veroptima-qa-fixture-files";
const PDF_EPOCH = new Date(0);

async function generatePdfDoc(
  params: PdfDocParams,
  ctx: GenContext,
): Promise<FileFixture> {
  const pages = params.pages ?? 1;
  const text = params.text ?? "Documento";

  const doc = await PDFDocument.create({ updateMetadata: false });

  // Force every metadata field to a constant. Any of these left to its
  // pdf-lib default would bake a timestamp/random string into the PDF.
  doc.setTitle(`seed:${ctx.seed}`);
  doc.setProducer(PDF_PRODUCER);
  doc.setCreator(PDF_PRODUCER);
  doc.setCreationDate(PDF_EPOCH);
  doc.setModificationDate(PDF_EPOCH);

  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]); // US Letter
    page.drawText(`${text} (page ${i + 1}/${pages})`, {
      x: 50,
      y: 742,
      size: 12,
      font,
    });
  }

  // Stabilise the trailer `/ID` array. pdf-lib seeds it from random per call,
  // so without this override two saves of the same logical PDF differ.
  const idHex = deriveIdHex(ctx.seed, "trailer-id");
  const idArr = doc.context.obj([
    PDFHexString.of(idHex),
    PDFHexString.of(idHex),
  ]) as PDFArray;
  doc.context.trailerInfo.ID = idArr;

  const bytes = await doc.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });

  return {
    kind: "file",
    filename: "documento.pdf",
    mediaType: "application/pdf",
    bytes,
  };
}

/** Derive a 16-byte hex string from `(seed, salt)` — for stable trailer IDs. */
function deriveIdHex(seed: string, salt: string): string {
  const prng = makePrng(`${seed}|${salt}`);
  let out = "";
  for (let i = 0; i < 16; i++) {
    const b = prng.nextByte();
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

// ── image-png (hand-rolled) ──────────────────────────────────────────────────
//
// PNG layout:
//   8-byte signature
//   IHDR chunk
//   IDAT chunk(s) — zlib-deflated raw pixel data with one filter byte per row
//   IEND chunk
//
// We emit a single IDAT with filter type 0 (None) for every scanline.

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n >>> 0;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const len = data.length;
  const out = new Uint8Array(8 + len + 4);
  // length (big-endian)
  out[0] = (len >>> 24) & 0xff;
  out[1] = (len >>> 16) & 0xff;
  out[2] = (len >>> 8) & 0xff;
  out[3] = len & 0xff;
  // type
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  // data
  out.set(data, 8);
  // crc over type+data
  const crcInput = new Uint8Array(4 + len);
  for (let i = 0; i < 4; i++) crcInput[i] = type.charCodeAt(i);
  crcInput.set(data, 4);
  const crc = crc32(crcInput);
  out[8 + len] = (crc >>> 24) & 0xff;
  out[8 + len + 1] = (crc >>> 16) & 0xff;
  out[8 + len + 2] = (crc >>> 8) & 0xff;
  out[8 + len + 3] = crc & 0xff;
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function generatePng(params: ImageParams, ctx: GenContext): FileFixture {
  const width = params.width ?? 16;
  const height = params.height ?? 16;
  const label = params.label ?? "";

  const prng = makePrng(`${ctx.seed}|png|${label}|${width}x${height}`);

  // RGBA raster. One filter byte per row.
  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const rowOff = y * (1 + stride);
    raw[rowOff] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const off = rowOff + 1 + x * 4;
      raw[off] = prng.nextByte(); // R
      raw[off + 1] = prng.nextByte(); // G
      raw[off + 2] = prng.nextByte(); // B
      raw[off + 3] = 0xff; // A = opaque
    }
  }

  // Build chunks.
  const signature = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  const ihdr = new Uint8Array(13);
  // width (BE)
  ihdr[0] = (width >>> 24) & 0xff;
  ihdr[1] = (width >>> 16) & 0xff;
  ihdr[2] = (width >>> 8) & 0xff;
  ihdr[3] = width & 0xff;
  // height (BE)
  ihdr[4] = (height >>> 24) & 0xff;
  ihdr[5] = (height >>> 16) & 0xff;
  ihdr[6] = (height >>> 8) & 0xff;
  ihdr[7] = height & 0xff;
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: standard
  ihdr[12] = 0; // interlace: none

  // zlib's deflate output is deterministic for a given input + level/strategy.
  // Pin level=9 explicitly so a runtime-default change can't shift bytes.
  const idatData = new Uint8Array(deflateSync(raw, { level: 9 }));

  const ihdrChunk = makeChunk("IHDR", ihdr);
  const idatChunk = makeChunk("IDAT", idatData);
  const iendChunk = makeChunk("IEND", new Uint8Array(0));

  const bytes = concatBytes([signature, ihdrChunk, idatChunk, iendChunk]);

  return {
    kind: "file",
    filename: "image.png",
    mediaType: "image/png",
    bytes,
  };
}

// ── image-jpg (hand-rolled baseline encoder) ────────────────────────────────
//
// Minimal baseline (SOF0) JPEG encoder. We use the standard JFIF luminance
// and chrominance quantization tables (Annex K) at quality ~50 (the tables
// as-is, no scaling), the standard Huffman tables (Annex K), and 4:4:4
// subsampling. Encoding is deterministic given identical pixel input + fixed
// tables; no timestamps or random fields anywhere.

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
];

// Standard luminance quantization (Annex K Table K.1) at "quality 50".
const QY = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16,
  24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
  103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const QC = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56,
  99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99,
];

// Standard Huffman tables (Annex K Table K.3/K.4/K.5/K.6).
const STD_DC_LUM_NRCODES = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const STD_DC_LUM_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const STD_AC_LUM_NRCODES = [
  0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d,
];
const STD_AC_LUM_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13,
  0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42,
  0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a,
  0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
  0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a,
  0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67,
  0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84,
  0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
  0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3,
  0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const STD_DC_CHROM_NRCODES = [
  0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0,
];
const STD_DC_CHROM_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const STD_AC_CHROM_NRCODES = [
  0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77,
];
const STD_AC_CHROM_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51,
  0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1,
  0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24,
  0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a,
  0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66,
  0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82,
  0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
  0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
  0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
  0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

interface HuffmanCode {
  code: number;
  length: number;
}

function buildHuffmanTable(
  nrcodes: number[],
  values: number[],
): HuffmanCode[] {
  const out: HuffmanCode[] = [];
  let code = 0;
  let k = 0;
  for (let i = 1; i <= 16; i++) {
    for (let j = 1; j <= nrcodes[i]!; j++) {
      out[values[k]!] = { code, length: i };
      code++;
      k++;
    }
    code <<= 1;
  }
  return out;
}

class JpegBitWriter {
  private parts: number[] = [];
  private buffer = 0;
  private bufferLen = 0;

  writeBits(code: number, length: number): void {
    let cur = this.buffer;
    let curLen = this.bufferLen;
    for (let i = length - 1; i >= 0; i--) {
      const bit = (code >> i) & 1;
      cur = (cur << 1) | bit;
      curLen++;
      if (curLen === 8) {
        const byte = cur & 0xff;
        this.parts.push(byte);
        if (byte === 0xff) {
          this.parts.push(0x00); // byte-stuffing per JPEG spec
        }
        cur = 0;
        curLen = 0;
      }
    }
    this.buffer = cur;
    this.bufferLen = curLen;
  }

  flush(): void {
    if (this.bufferLen > 0) {
      // pad with 1s per JPEG spec
      const byte = ((this.buffer << (8 - this.bufferLen)) | ((1 << (8 - this.bufferLen)) - 1)) & 0xff;
      this.parts.push(byte);
      if (byte === 0xff) this.parts.push(0x00);
      this.buffer = 0;
      this.bufferLen = 0;
    }
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

// FDCT (Forward DCT) — straightforward 8x8 implementation; accuracy isn't
// load-bearing, but the operations must be deterministic. We use the
// AAN-style fast DCT for compactness.
function fdct(block: number[]): number[] {
  // Two-pass: rows then columns, with the standard 8-point DCT-II.
  const tmp = new Array<number>(64);
  // Rows
  for (let i = 0; i < 8; i++) {
    const row = i * 8;
    const x0 = block[row]!;
    const x1 = block[row + 1]!;
    const x2 = block[row + 2]!;
    const x3 = block[row + 3]!;
    const x4 = block[row + 4]!;
    const x5 = block[row + 5]!;
    const x6 = block[row + 6]!;
    const x7 = block[row + 7]!;
    for (let k = 0; k < 8; k++) {
      let s = 0;
      for (let n = 0; n < 8; n++) {
        s +=
          [x0, x1, x2, x3, x4, x5, x6, x7][n]! *
          Math.cos(((2 * n + 1) * k * Math.PI) / 16);
      }
      const c = k === 0 ? 1 / Math.SQRT2 : 1;
      tmp[row + k] = 0.5 * c * s;
    }
  }
  // Columns
  const out = new Array<number>(64);
  for (let j = 0; j < 8; j++) {
    for (let k = 0; k < 8; k++) {
      let s = 0;
      for (let n = 0; n < 8; n++) {
        s += tmp[n * 8 + j]! * Math.cos(((2 * n + 1) * k * Math.PI) / 16);
      }
      const c = k === 0 ? 1 / Math.SQRT2 : 1;
      out[k * 8 + j] = 0.5 * c * s;
    }
  }
  return out;
}

function encodeBlock(
  block: number[],
  q: number[],
  prevDC: number,
  dcTable: HuffmanCode[],
  acTable: HuffmanCode[],
  writer: JpegBitWriter,
): number {
  const dct = fdct(block);
  const quant = new Array<number>(64);
  for (let i = 0; i < 64; i++) {
    quant[i] = Math.round(dct[i]! / q[i]!);
  }
  // Reorder into zigzag.
  const zz = new Array<number>(64);
  for (let i = 0; i < 64; i++) zz[i] = quant[ZIGZAG[i]!]!;

  // DC
  const diff = zz[0]! - prevDC;
  encodeCoefficient(diff, dcTable, writer, true);

  // AC
  let runLength = 0;
  for (let i = 1; i < 64; i++) {
    if (zz[i] === 0) {
      runLength++;
    } else {
      while (runLength > 15) {
        // ZRL
        const zrl = acTable[0xf0]!;
        writer.writeBits(zrl.code, zrl.length);
        runLength -= 16;
      }
      encodeAc(runLength, zz[i]!, acTable, writer);
      runLength = 0;
    }
  }
  if (runLength > 0) {
    // EOB
    const eob = acTable[0x00]!;
    writer.writeBits(eob.code, eob.length);
  }
  return zz[0]!;
}

function category(v: number): number {
  if (v === 0) return 0;
  const a = Math.abs(v);
  let c = 0;
  let t = a;
  while (t > 0) {
    c++;
    t >>= 1;
  }
  return c;
}

function encodeCoefficient(
  v: number,
  table: HuffmanCode[],
  writer: JpegBitWriter,
  isDc: boolean,
): void {
  const cat = category(v);
  if (isDc) {
    const sym = table[cat]!;
    writer.writeBits(sym.code, sym.length);
  }
  if (cat > 0) {
    const bits = v < 0 ? (1 << cat) - 1 + v : v;
    writer.writeBits(bits, cat);
  }
}

function encodeAc(
  run: number,
  v: number,
  table: HuffmanCode[],
  writer: JpegBitWriter,
): void {
  const cat = category(v);
  const sym = table[(run << 4) | cat]!;
  writer.writeBits(sym.code, sym.length);
  const bits = v < 0 ? (1 << cat) - 1 + v : v;
  writer.writeBits(bits, cat);
}

function rgbToYCbCr(r: number, g: number, b: number): [number, number, number] {
  // ITU-R BT.601
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
  const cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
  return [y - 128, cb - 128, cr - 128];
}

function generateJpg(params: ImageParams, ctx: GenContext): FileFixture {
  // Quantize width/height up to multiples of 8 (we encode block-by-block).
  const reqW = params.width ?? 16;
  const reqH = params.height ?? 16;
  const w = Math.ceil(reqW / 8) * 8;
  const h = Math.ceil(reqH / 8) * 8;
  const label = params.label ?? "";

  const prng = makePrng(`${ctx.seed}|jpg|${label}|${w}x${h}`);

  // Per-pixel YCbCr planes.
  const yPlane = new Array<number>(w * h);
  const cbPlane = new Array<number>(w * h);
  const crPlane = new Array<number>(w * h);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const r = prng.nextByte();
      const g = prng.nextByte();
      const b = prng.nextByte();
      const [y, cb, cr] = rgbToYCbCr(r, g, b);
      const idx = py * w + px;
      yPlane[idx] = y;
      cbPlane[idx] = cb;
      crPlane[idx] = cr;
    }
  }

  const dcLumTable = buildHuffmanTable(STD_DC_LUM_NRCODES, STD_DC_LUM_VALUES);
  const acLumTable = buildHuffmanTable(STD_AC_LUM_NRCODES, STD_AC_LUM_VALUES);
  const dcChromTable = buildHuffmanTable(
    STD_DC_CHROM_NRCODES,
    STD_DC_CHROM_VALUES,
  );
  const acChromTable = buildHuffmanTable(
    STD_AC_CHROM_NRCODES,
    STD_AC_CHROM_VALUES,
  );

  // Encode all blocks (4:4:4 — three planes, no subsampling).
  const writer = new JpegBitWriter();
  let prevYDc = 0;
  let prevCbDc = 0;
  let prevCrDc = 0;
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      const yBlock = extractBlock(yPlane, w, bx, by);
      const cbBlock = extractBlock(cbPlane, w, bx, by);
      const crBlock = extractBlock(crPlane, w, bx, by);
      prevYDc = encodeBlock(yBlock, QY, prevYDc, dcLumTable, acLumTable, writer);
      prevCbDc = encodeBlock(
        cbBlock,
        QC,
        prevCbDc,
        dcChromTable,
        acChromTable,
        writer,
      );
      prevCrDc = encodeBlock(
        crBlock,
        QC,
        prevCrDc,
        dcChromTable,
        acChromTable,
        writer,
      );
    }
  }
  writer.flush();
  const scanBytes = writer.toBytes();

  // Assemble the JPEG file.
  const segments: number[] = [];
  // SOI
  segments.push(0xff, 0xd8);
  // APP0 (JFIF)
  segments.push(0xff, 0xe0);
  segments.push(0x00, 0x10); // length 16
  segments.push(0x4a, 0x46, 0x49, 0x46, 0x00); // "JFIF\0"
  segments.push(0x01, 0x01); // version 1.1
  segments.push(0x00); // aspect ratio units = none
  segments.push(0x00, 0x01, 0x00, 0x01); // X density 1, Y density 1
  segments.push(0x00, 0x00); // thumbnail dims
  // DQT (luma)
  segments.push(0xff, 0xdb);
  segments.push(0x00, 0x43); // length 67
  segments.push(0x00); // table id 0, precision 8
  for (let i = 0; i < 64; i++) segments.push(QY[ZIGZAG[i]!]!);
  // DQT (chroma)
  segments.push(0xff, 0xdb);
  segments.push(0x00, 0x43);
  segments.push(0x01);
  for (let i = 0; i < 64; i++) segments.push(QC[ZIGZAG[i]!]!);
  // SOF0
  segments.push(0xff, 0xc0);
  segments.push(0x00, 0x11); // length 17
  segments.push(0x08); // precision
  segments.push((h >> 8) & 0xff, h & 0xff);
  segments.push((w >> 8) & 0xff, w & 0xff);
  segments.push(0x03); // 3 components
  // Y: id 1, sampling 0x11 (1h1v), quant table 0
  segments.push(0x01, 0x11, 0x00);
  segments.push(0x02, 0x11, 0x01);
  segments.push(0x03, 0x11, 0x01);
  // DHT
  writeHuffmanTable(segments, 0x00, STD_DC_LUM_NRCODES, STD_DC_LUM_VALUES);
  writeHuffmanTable(segments, 0x10, STD_AC_LUM_NRCODES, STD_AC_LUM_VALUES);
  writeHuffmanTable(segments, 0x01, STD_DC_CHROM_NRCODES, STD_DC_CHROM_VALUES);
  writeHuffmanTable(segments, 0x11, STD_AC_CHROM_NRCODES, STD_AC_CHROM_VALUES);
  // SOS
  segments.push(0xff, 0xda);
  segments.push(0x00, 0x0c); // length 12
  segments.push(0x03);
  segments.push(0x01, 0x00); // Y: dc 0, ac 0
  segments.push(0x02, 0x11); // Cb: dc 1, ac 1
  segments.push(0x03, 0x11); // Cr: dc 1, ac 1
  segments.push(0x00, 0x3f, 0x00);
  // entropy-coded scan
  for (const b of scanBytes) segments.push(b);
  // EOI
  segments.push(0xff, 0xd9);

  return {
    kind: "file",
    filename: "image.jpg",
    mediaType: "image/jpeg",
    bytes: Uint8Array.from(segments),
  };
}

function extractBlock(
  plane: number[],
  stride: number,
  bx: number,
  by: number,
): number[] {
  const out = new Array<number>(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      out[y * 8 + x] = plane[(by + y) * stride + (bx + x)]!;
    }
  }
  return out;
}

function writeHuffmanTable(
  segments: number[],
  tableId: number,
  nrcodes: number[],
  values: number[],
): void {
  const len = 19 + values.length; // 2 (length) + 1 (id) + 16 (nrcodes) + N
  segments.push(0xff, 0xc4);
  segments.push((len >> 8) & 0xff, len & 0xff);
  segments.push(tableId);
  for (let i = 1; i <= 16; i++) segments.push(nrcodes[i]!);
  for (const v of values) segments.push(v);
}

// ── zip (jszip) ──────────────────────────────────────────────────────────────

async function generateZip(
  params: ZipParams,
  _ctx: GenContext,
): Promise<FileFixture> {
  const zip = new JSZip();
  const FIXED_DATE = new Date(0);
  for (const entry of params.entries) {
    zip.file(entry.name, entry.content, {
      date: FIXED_DATE,
      // jszip nests platform info; pin to UNIX (3) so we don't get host drift.
      // dosPermissions and unixPermissions left undefined so jszip uses its
      // own constants, which are themselves stable.
      createFolders: false,
    });
  }
  const buf = await zip.generateAsync({
    type: "uint8array",
    // STORE for fully deterministic output. DEFLATE under jszip is also
    // deterministic in practice (single-threaded zlib), but STORE removes a
    // whole layer of "could the lib change its level/strategy default."
    compression: "STORE",
    // platform "UNIX" → fixed external attributes. Default is host-dependent.
    platform: "UNIX",
  });

  return {
    kind: "file",
    filename: "bundle.zip",
    mediaType: "application/zip",
    bytes: buf,
  };
}

// ── Generator definitions ────────────────────────────────────────────────────

export const pdfDocGenerator: Generator<PdfDocParams, FileFixture> = {
  kind: "pdf-doc",
  outputs: "file",
  paramsSchema: PdfDocParamsSchema,
  generate: generatePdfDoc,
};

export const imagePngGenerator: Generator<ImageParams, FileFixture> = {
  kind: "image-png",
  outputs: "file",
  paramsSchema: ImageParamsSchema,
  generate: generatePng,
};

export const imageJpgGenerator: Generator<ImageParams, FileFixture> = {
  kind: "image-jpg",
  outputs: "file",
  paramsSchema: ImageParamsSchema,
  generate: generateJpg,
};

export const zipGenerator: Generator<ZipParams, FileFixture> = {
  kind: "zip",
  outputs: "file",
  paramsSchema: ZipParamsSchema,
  generate: generateZip,
};

// The pack contract's `generators` field is `ReadonlyArray<Generator>`, where
// `Generator` defaults its param type to `void`. Each concrete generator
// declares a strictly-typed `P` (PdfDocParams etc.), so we cast through
// `unknown` to land in the generic array. The runtime contract enforces
// `paramsSchema` so the loose typing here doesn't widen the input surface.
export const generators: Generator[] = [
  pdfDocGenerator as unknown as Generator,
  imagePngGenerator as unknown as Generator,
  imageJpgGenerator as unknown as Generator,
  zipGenerator as unknown as Generator,
];

// ── Pack assembly ────────────────────────────────────────────────────────────

const manifest = FixturePackManifestSchema.parse(manifestJson);

export const pack: FixturePack = defineFixturePack({
  manifest,
  generators,
});

export default pack;
