/**
 * Tests for veroptima-qa-fixture-files.
 *
 * The LOAD-BEARING tests in this suite are the cross-call determinism checks:
 * for each kind, two invocations with the same (seed, params) must produce
 * byte-identical `bytes`. If any of these fail, the pack must NOT ship.
 *
 * We also assert a small set of format-level invariants (PDF magic + page
 * count + literal text; PNG/JPG magic; ZIP round-trips back to the input).
 */
import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";
import pack, {
  pdfDocGenerator,
  imagePngGenerator,
  imageJpgGenerator,
  zipGenerator,
  type PdfDocParams,
  type ImageParams,
  type ZipParams,
} from "../index.js";
import type { FileFixture, GenContext } from "@qa-expert/fixture-pack-contract";

function noopLogger() {
  return {
    debug: (): void => {},
    info: (): void => {},
    warn: (): void => {},
    error: (): void => {},
  };
}

function makeCtx(seed = "seed-1", locale?: string): GenContext {
  return {
    seed,
    locale,
    logger: noopLogger(),
  };
}

/** Byte-by-byte 1:1 decode (ISO-8859-1-style) — works for any byte sequence. */
function decodeBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]!);
  }
  return s;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe("pack assembly", () => {
  test("manifest matches the declared kinds", () => {
    expect(pack.manifest.name).toBe("veroptima-qa-fixture-files");
    expect(pack.manifest.domain).toBe("files");
    expect(pack.manifest.family).toBe("fixture-pack");
    const names = pack.manifest.kinds.map((k) => k.name).sort();
    expect(names).toEqual(["image-jpg", "image-png", "pdf-doc", "zip"]);
  });

  test("every kind is file-output", () => {
    for (const k of pack.manifest.kinds) {
      expect(k.outputs).toBe("file");
    }
    for (const g of pack.generators) {
      expect(g.outputs).toBe("file");
    }
  });

  test("pack is frozen", () => {
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.generators)).toBe(true);
  });
});

// ── pdf-doc ──────────────────────────────────────────────────────────────────

describe("pdf-doc", () => {
  const params: PdfDocParams = { pages: 2, text: "Documento de teste" };

  test("starts with the PDF magic bytes", async () => {
    const out = (await pdfDocGenerator.generate(params, makeCtx())) as FileFixture;
    // %PDF-
    expect(out.bytes[0]).toBe(0x25);
    expect(out.bytes[1]).toBe(0x50);
    expect(out.bytes[2]).toBe(0x44);
    expect(out.bytes[3]).toBe(0x46);
    expect(out.bytes[4]).toBe(0x2d);
  });

  test("declares the correct mediaType + filename", async () => {
    const out = (await pdfDocGenerator.generate(params, makeCtx())) as FileFixture;
    expect(out.mediaType).toBe("application/pdf");
    expect(out.filename).toBe("documento.pdf");
    expect(out.kind).toBe("file");
  });

  test("loads back as a valid PDF with the requested page count", async () => {
    const out = (await pdfDocGenerator.generate(
      { pages: 3, text: "Trio" },
      makeCtx(),
    )) as FileFixture;
    const loaded = await PDFDocument.load(out.bytes);
    expect(loaded.getPageCount()).toBe(3);
  });

  test("defaults to 1 page + 'Documento'", async () => {
    const out = (await pdfDocGenerator.generate({}, makeCtx())) as FileFixture;
    const loaded = await PDFDocument.load(out.bytes);
    expect(loaded.getPageCount()).toBe(1);
  });

  test("embeds the requested text in a content stream", async () => {
    const out = (await pdfDocGenerator.generate(
      { pages: 1, text: "MarcadorUnico" },
      makeCtx(),
    )) as FileFixture;
    // pdf-lib FlateDecode-compresses content streams by default and writes
    // the drawText payload as a hex string (`<4D61...> Tj`). Walk every
    // `stream ... endstream` window, inflate it, then scan for either the
    // literal needle (parenthesised string operator) or the hex-encoded
    // form (the hex-string operator that pdf-lib actually emits with
    // Helvetica).
    const haystack = decodeBytes(out.bytes);
    const needle = "MarcadorUnico";
    const hexNeedle = Array.from(needle)
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let found = false;
    let m: RegExpExecArray | null;
    while ((m = streamRe.exec(haystack)) !== null) {
      const raw = m[1]!;
      const buf = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      try {
        const inflated = inflateSync(buf);
        const text = decodeBytes(new Uint8Array(inflated));
        const textUpper = text.toUpperCase();
        if (text.includes(needle) || textUpper.includes(hexNeedle)) {
          found = true;
          break;
        }
      } catch {
        // Not a deflate stream (e.g. cross-reference); skip.
      }
    }
    expect(found).toBe(true);
  });

  test("DETERMINISM: two calls with same seed+params produce byte-identical output", async () => {
    const a = (await pdfDocGenerator.generate(params, makeCtx("seed-1"))) as FileFixture;
    const b = (await pdfDocGenerator.generate(params, makeCtx("seed-1"))) as FileFixture;
    expect(a.bytes.length).toBe(b.bytes.length);
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
  });

  test("different seeds produce different output (trailer /ID changes)", async () => {
    const a = (await pdfDocGenerator.generate(params, makeCtx("seed-1"))) as FileFixture;
    const b = (await pdfDocGenerator.generate(params, makeCtx("seed-2"))) as FileFixture;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(false);
  });
});

// ── image-png ────────────────────────────────────────────────────────────────

describe("image-png", () => {
  const params: ImageParams = { width: 8, height: 8, label: "tag" };

  test("starts with the PNG magic", () => {
    const out = imagePngGenerator.generate(params, makeCtx()) as FileFixture;
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < magic.length; i++) {
      expect(out.bytes[i]).toBe(magic[i]!);
    }
  });

  test("declares mediaType image/png", () => {
    const out = imagePngGenerator.generate(params, makeCtx()) as FileFixture;
    expect(out.mediaType).toBe("image/png");
    expect(out.kind).toBe("file");
  });

  test("DETERMINISM: same seed+params produce byte-identical output", () => {
    const a = imagePngGenerator.generate(params, makeCtx("seed-1")) as FileFixture;
    const b = imagePngGenerator.generate(params, makeCtx("seed-1")) as FileFixture;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
  });

  test("different seed → different bytes", () => {
    const a = imagePngGenerator.generate(params, makeCtx("seed-1")) as FileFixture;
    const b = imagePngGenerator.generate(params, makeCtx("seed-2")) as FileFixture;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(false);
  });

  test("different params → different bytes", () => {
    const a = imagePngGenerator.generate({ width: 8, height: 8 }, makeCtx()) as FileFixture;
    const b = imagePngGenerator.generate({ width: 16, height: 16 }, makeCtx()) as FileFixture;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(false);
  });
});

// ── image-jpg ────────────────────────────────────────────────────────────────

describe("image-jpg", () => {
  const params: ImageParams = { width: 16, height: 16, label: "tag" };

  test("starts with the JPEG SOI marker", () => {
    const out = imageJpgGenerator.generate(params, makeCtx()) as FileFixture;
    expect(out.bytes[0]).toBe(0xff);
    expect(out.bytes[1]).toBe(0xd8);
    expect(out.bytes[2]).toBe(0xff);
  });

  test("ends with the JPEG EOI marker", () => {
    const out = imageJpgGenerator.generate(params, makeCtx()) as FileFixture;
    expect(out.bytes[out.bytes.length - 2]).toBe(0xff);
    expect(out.bytes[out.bytes.length - 1]).toBe(0xd9);
  });

  test("declares mediaType image/jpeg", () => {
    const out = imageJpgGenerator.generate(params, makeCtx()) as FileFixture;
    expect(out.mediaType).toBe("image/jpeg");
    expect(out.kind).toBe("file");
  });

  test("DETERMINISM: same seed+params produce byte-identical output", () => {
    const a = imageJpgGenerator.generate(params, makeCtx("seed-1")) as FileFixture;
    const b = imageJpgGenerator.generate(params, makeCtx("seed-1")) as FileFixture;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
  });

  test("different seed → different bytes", () => {
    const a = imageJpgGenerator.generate(params, makeCtx("seed-1")) as FileFixture;
    const b = imageJpgGenerator.generate(params, makeCtx("seed-2")) as FileFixture;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(false);
  });
});

// ── zip ──────────────────────────────────────────────────────────────────────

describe("zip", () => {
  const params: ZipParams = {
    entries: [
      { name: "a.txt", content: "hello\n" },
      { name: "nested/b.txt", content: "world\n" },
    ],
  };

  test("starts with the ZIP local-file-header signature PK\\x03\\x04", async () => {
    const out = (await zipGenerator.generate(params, makeCtx())) as FileFixture;
    expect(out.bytes[0]).toBe(0x50);
    expect(out.bytes[1]).toBe(0x4b);
    expect(out.bytes[2]).toBe(0x03);
    expect(out.bytes[3]).toBe(0x04);
  });

  test("declares mediaType application/zip", async () => {
    const out = (await zipGenerator.generate(params, makeCtx())) as FileFixture;
    expect(out.mediaType).toBe("application/zip");
    expect(out.kind).toBe("file");
  });

  test("extracts cleanly and round-trips member contents", async () => {
    const out = (await zipGenerator.generate(params, makeCtx())) as FileFixture;
    const loaded = await JSZip.loadAsync(out.bytes);
    const names = Object.keys(loaded.files).sort();
    expect(names).toEqual(["a.txt", "nested/b.txt"]);
    for (const entry of params.entries) {
      const file = loaded.file(entry.name);
      expect(file).not.toBeNull();
      const text = await file!.async("string");
      expect(text).toBe(entry.content);
    }
  });

  test("DETERMINISM: same seed+params produce byte-identical output", async () => {
    const a = (await zipGenerator.generate(params, makeCtx("seed-1"))) as FileFixture;
    const b = (await zipGenerator.generate(params, makeCtx("seed-1"))) as FileFixture;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
  });

  test("DETERMINISM: also stable across different seeds (zip content does not depend on seed)", async () => {
    // The zip kind is a pure container; its bytes depend only on `params.entries`
    // because every entry's date is fixed and the platform/compression pinned.
    const a = (await zipGenerator.generate(params, makeCtx("seed-1"))) as FileFixture;
    const b = (await zipGenerator.generate(params, makeCtx("seed-2"))) as FileFixture;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
  });
});
