// Visual regression of report layouts: each template is filled with field names, converted
// by the real Word engine and compared page by page with approved baseline images.
//
//   bun test templates/tests/visual.test.ts                   (a representative set)
//   VISUAL_ALL=1 bun test templates/tests/visual.test.ts      (all 51 originals)
//   UPDATE_BASELINES=1 bun test templates/tests/visual.test.ts  (accept the current look)
//
// Needs LibreOffice or Microsoft Word; skipped (with a message) when neither is installed.
// Baselines depend on the engine and its fonts, so they are stored per engine.
import { describe, expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { allFields } from "../definition.ts";
import { availableEngine, docxToPdf } from "../convert.ts";
import { renderTemplate } from "../render.ts";
import { scanTemplate } from "../scan.ts";

const ARCHIVE = join(import.meta.dir, "..", "..", "..", "..", "Investigation Forms");
const CONVERTED = join(import.meta.dir, "..", "..", "..", "DynamicForms_Services", "Seeds", "converted-doc");
const VISUAL = join(import.meta.dir, "visual");
const UPDATE = process.env.UPDATE_BASELINES === "1";
const SCALE = 0.75;
// Share of pixels allowed to differ (anti-aliasing noise), and how different a pixel must be.
const MAX_DIFF_RATIO = 0.004;
const PIXEL_THRESHOLD = 48;

const REPRESENTATIVE = [
  "Bedayty Company/استعلام سكن",
  "Credit agricole Bank/استعلام عيادة",
  "Gaboor Company/استعلام منزل",
  "Alex Bank/استعلام عمل",
  "QNB Bank/تقرير سكن",
  "Tanmiya Company/استعلام متابعه",
];

const engine = await availableEngine();

function archive(): { id: string; key: string; path: string }[] {
  const out: { id: string; key: string; path: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      // Word's lock file («~$…») while a form is open is not a form.
      if (name.startsWith("~$")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const rel = relative(ARCHIVE, path).replaceAll("\\", "/");
        const [client, folder] = rel.split("/");
        const key = `${client}/${folder}`;
        const docx = path.toLowerCase().endsWith(".doc") ? join(CONVERTED, `${client}__${folder}.docx`) : path;
        out.push({ id: `${out.length + 1}`.padStart(2, "0"), key, path: docx });
      }
    }
  };
  walk(ARCHIVE);
  return out;
}

async function pdfjs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

/** Every page of a PDF as RGBA pixels. */
async function rasterize(pdf: Uint8Array): Promise<{ width: number; height: number; data: Uint8ClampedArray; png: Buffer }[]> {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: pdf.slice(), isEvalSupported: false }).promise;
  const pages = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context as never, viewport }).promise;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    pages.push({ width: canvas.width, height: canvas.height, data: image.data, png: canvas.toBuffer("image/png") });
  }
  return pages;
}

async function pixels(png: Buffer) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
}

/** Share of differing pixels, plus a red-on-grey picture of where they differ. */
function compare(a: { width: number; height: number; data: Uint8ClampedArray }, b: { width: number; height: number; data: Uint8ClampedArray }) {
  if (a.width !== b.width || a.height !== b.height) return { ratio: 1, diff: null as Buffer | null };
  const canvas = createCanvas(a.width, a.height);
  const context = canvas.getContext("2d");
  const out = context.createImageData(a.width, a.height);
  let different = 0;
  for (let index = 0; index < a.data.length; index += 4) {
    const delta = Math.max(
      Math.abs(a.data[index]! - b.data[index]!),
      Math.abs(a.data[index + 1]! - b.data[index + 1]!),
      Math.abs(a.data[index + 2]! - b.data[index + 2]!),
    );
    const grey = Math.round((a.data[index]! + a.data[index + 1]! + a.data[index + 2]!) / 3);
    if (delta > PIXEL_THRESHOLD) {
      different += 1;
      out.data.set([230, 30, 40, 255], index);
    } else out.data.set([grey, grey, grey, 90], index);
  }
  context.putImageData(out, 0, 0);
  return { ratio: different / (a.width * a.height), diff: canvas.toBuffer("image/png") };
}

/** The layout filled with «field names»: deterministic, shows every binding. */
function labelled(path: string) {
  const scan = scanTemplate(new Uint8Array(readFileSync(path)));
  return {
    scan,
    docx: renderTemplate(scan.docx, scan.bindings, {
      definition: scan.definition,
      answers: {},
      caseValues: {},
      images: {},
      evidence: { photos: {}, locations: [] },
      preview: "labels",
    }).docx,
  };
}

const describeVisual = engine ? describe : describe.skip;
if (!engine) console.log("SKIP visual tests: install LibreOffice (SOFFICE_PATH) or Microsoft Word to render layouts.");

describeVisual(`report layouts (${engine ?? "no engine"})`, () => {
  const set = process.env.VISUAL_ALL === "1" ? archive() : archive().filter((item) => REPRESENTATIVE.includes(item.key));
  const baselines = join(VISUAL, "baselines", engine ?? "none");
  const output = join(VISUAL, "output");
  mkdirSync(baselines, { recursive: true });
  mkdirSync(output, { recursive: true });

  for (const item of set) {
    test(
      `${item.id} ${item.key} matches its approved baseline`,
      async () => {
        const { docx } = labelled(item.path);
        const pdf = (await docxToPdf(docx)).bytes;
        const pages = await rasterize(pdf);
        const manifestPath = join(baselines, `${item.id}.json`);
        if (UPDATE || !existsSync(manifestPath)) {
          if (!UPDATE) throw new Error(`No baseline for ${item.key}. Review the output and run with UPDATE_BASELINES=1.`);
          pages.forEach((page, index) => writeFileSync(join(baselines, `${item.id}-p${index + 1}.png`), page.png));
          writeFileSync(manifestPath, JSON.stringify({ key: item.key, pages: pages.length }, null, 2));
          return;
        }
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { pages: number };
        expect(pages.length).toBe(manifest.pages);
        const failures: string[] = [];
        for (const [index, page] of pages.entries()) {
          const baseline = await pixels(readFileSync(join(baselines, `${item.id}-p${index + 1}.png`)));
          const { ratio, diff } = compare(page, baseline);
          if (ratio > MAX_DIFF_RATIO) {
            writeFileSync(join(output, `${item.id}-p${index + 1}-actual.png`), page.png);
            if (diff) writeFileSync(join(output, `${item.id}-p${index + 1}-diff.png`), diff);
            failures.push(`page ${index + 1}: ${(ratio * 100).toFixed(2)}% of pixels differ`);
          }
        }
        expect(failures).toEqual([]);
      },
      180_000,
    );
  }

  test(
    "Arabic in the report is real, searchable text with the client's wording",
    async () => {
      const item = archive().find((entry) => entry.key === "Bedayty Company/استعلام سكن")!;
      const scan = scanTemplate(new Uint8Array(readFileSync(item.path)));
      const docx = renderTemplate(scan.docx, scan.bindings, {
        definition: scan.definition,
        answers: { subject_name: "محمد عبد الرحمن" },
        caseValues: {},
        images: {},
        evidence: { photos: {}, locations: [] },
      }).docx;
      const lib = await pdfjs();
      const doc = await lib.getDocument({ data: (await docxToPdf(docx)).bytes, isEvalSupported: false }).promise;
      const content = await (await doc.getPage(1)).getTextContent();
      const text = content.items.map((entry) => ("str" in entry ? entry.str : "")).join(" ").normalize("NFKC").replace(/\s+/g, " ");
      const has = (phrase: string) => text.includes(phrase) || text.includes([...phrase].reverse().join(""));
      expect(has("سكن العميل")).toBe(true);
      expect(has("محمد") && has("الرحمن")).toBe(true);
    },
    180_000,
  );

  test(
    "visit photos are embedded as pictures in the PDF",
    async () => {
      const item = archive().find((entry) => entry.key === "Bedayty Company/استعلام سكن")!;
      const scan = scanTemplate(new Uint8Array(readFileSync(item.path)));
      const photosField = allFields(scan.definition).find((field) => field.type === "photos")!;
      const photo = new Uint8Array(readFileSync(join(import.meta.dir, "..", "assets", "sample-photo.png")));
      const build = async (withPhoto: boolean) => {
        const docx = renderTemplate(scan.docx, scan.bindings, {
          definition: scan.definition,
          answers: {},
          caseValues: {},
          images: withPhoto ? { [photosField.key]: [{ bytes: photo }, { bytes: photo }] } : {},
          evidence: { photos: {}, locations: [] },
        }).docx;
        const text = new TextDecoder("latin1").decode((await docxToPdf(docx)).bytes);
        return (text.match(/\/Subtype\s*\/Image/g) ?? []).length;
      };
      expect(await build(true)).toBeGreaterThan(await build(false));
    },
    240_000,
  );

  test(
    "filling a blank form never changes the client's page count",
    async () => {
      for (const key of ["Industrial Development Bank/استعلام موظف", "CIB Bank/تقرير استعلام المشروعات"]) {
        const item = archive().find((entry) => entry.key === key)!;
        const scan = scanTemplate(new Uint8Array(readFileSync(item.path)));
        const blank = renderTemplate(scan.docx, scan.bindings, {
          definition: scan.definition,
          answers: {},
          caseValues: {},
          images: {},
          evidence: { photos: {}, locations: [] },
        }).docx;
        const prepared = (await docxToPdf(scan.docx)).pages;
        const filled = (await docxToPdf(blank)).pages;
        // Old photos and sample text are removed, so pages can only shrink, never grow.
        expect(filled).toBeLessThanOrEqual(prepared!);
        expect(filled).toBeGreaterThanOrEqual(1);
      }
    },
    300_000,
  );
});
