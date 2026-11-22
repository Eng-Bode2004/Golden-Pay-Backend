// One photo per page and QR codes for locations, on a small invented layout.
import { expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attr, descendants, DocxPackage, type El, NS, textOf } from "../docx.ts";
import { answerPlace } from "../location.ts";
import { renderTemplate } from "../render.ts";

const photo = new Uint8Array(readFileSync(join(import.meta.dir, "..", "assets", "sample-photo.png")));
const LINK = "https://maps.google.com/?q=30.038400,31.211300";

function layout(rowRule = "atLeast", top = 1440): Uint8Array {
  const mark = (id: number, name: string) => `<w:bookmarkStart w:id="${id}" w:name="${name}"/><w:bookmarkEnd w:id="${id}"/>`;
  return zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "word/document.xml": strToU8(`<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}"><w:body>
      <w:tbl><w:tr><w:trPr><w:trHeight w:val="400" w:hRule="${rowRule}"/></w:trPr><w:tc><w:tcPr><w:tcW w:w="4000"/></w:tcPr><w:p>${mark(1, "gp_loc")}</w:p></w:tc>
      <w:tc><w:p>${mark(2, "gp_inside")}</w:p></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:t>صور السكن</w:t></w:r></w:p><w:p>${mark(3, "gp_closing")}</w:p><w:p/>
      <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${top}" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`),
  });
}

function render(bytes = layout(), gps: string | null = "30.03840, 31.21130") {
  const out = renderTemplate(
    bytes,
    [
      { anchor: "gp_loc", action: "text", source: "answers.loc" },
      { anchor: "gp_inside", action: "image", source: "answers.work" },
      { anchor: "gp_closing", action: "image", source: "answers.home" },
    ],
    {
      definition: {
        schema: 2,
        sections: [
          {
            title: "الزيارة",
            fields: [
              { key: "loc", label: "تحديد الموقع", type: "text" },
              { key: "work", label: "صور العمل", type: "photos" },
              { key: "home", label: "صور السكن", type: "photos" },
              { key: "extra", label: "صور أخرى", type: "photos" },
            ],
          },
        ],
      } as never,
      answers: { loc: LINK },
      caseValues: { gps },
      images: { work: [{ bytes: photo }, { bytes: photo }], home: [{ bytes: photo }], extra: [{ bytes: photo }] },
      evidence: { photos: {}, locations: [] },
    },
  );
  const pkg = DocxPackage.open(out.docx);
  const root = pkg.xml("word/document.xml").documentElement as El;
  const breaks = descendants(root, "p").filter((p) => descendants(p, "pageBreakBefore").length);
  return { pkg, root, breaks };
}

test("every photo starts a page of its own, placed in the layout or not", () => {
  const { root, breaks } = render();
  expect(breaks.map((p) => textOf(p).trim())).toEqual(["صور العمل (1 من 2)", "صور العمل (2 من 2)", "صور السكن", "صور أخرى"]);
  for (const caption of breaks) expect(descendants(caption.nextSibling as El, "blip", NS.a).length).toBe(1);
  // The photo box in the table says where the photos went and holds none of them.
  const box = descendants(root, "tc")[1]!;
  expect(textOf(box)).toContain("الصور مرفقة");
  expect(descendants(box, "blip", NS.a).length).toBe(0);
});

test("a location prints as a QR code with its link, not as a long address", () => {
  const { pkg, root } = render();
  const box = descendants(root, "tc")[0]!;
  expect(descendants(box, "blip", NS.a).length).toBe(1);
  expect(textOf(box)).not.toContain("https://");
  const link = descendants(box, "hyperlink")[0]!;
  expect(textOf(link)).toBe("30.03840,31.21130");
  const rels = new TextDecoder().decode(pkg.bytes("word/_rels/document.xml.rels"));
  expect(rels).toContain(`Target="${LINK}"`);
  expect(rels).toContain('TargetMode="External"');
});

test("the visit's location has a code too, and none is printed without GPS", () => {
  expect(descendants(render().root, "hyperlink").length).toBe(2);
  expect(descendants(render(layout(), null).root, "hyperlink").length).toBe(1);
});

test("a box that cannot grow keeps the link text", () => {
  const box = descendants(render(layout("exact")).root, "tc")[0]!;
  expect(descendants(box, "blip", NS.a).length).toBe(0);
  expect(textOf(box)).toContain("30.03840,31.21130");
});

test("with almost no top margin the caption stays off the paper's edge", () => {
  const spacing = descendants(render(layout("atLeast", 0)).breaks[0]!, "spacing")[0];
  expect(Number(attr(spacing, "line"))).toBeGreaterThan(566);
});

test("only Google Maps links and real coordinates become codes", () => {
  const field = { type: "text" as const, label: "تحديد الموقع" };
  expect(answerPlace(field, "30.038400, 31.211300")?.label).toBe("30.03840,31.21130");
  expect(answerPlace({ type: "text", label: "ملاحظات" }, "30.038400, 31.211300")).toBeNull();
  expect(answerPlace(field, "https://maps.google.com.evil.example/?q=30.1,31.2")).toBeNull();
  expect(answerPlace(field, "95.12345,31.22222")).toBeNull();
  expect(answerPlace(field, "لم يتم التعرف عليه")).toBeNull();
});
