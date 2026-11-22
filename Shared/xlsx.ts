import { unzipSync, strFromU8 } from "fflate";

/**
 * A small .xlsx reader: every sheet as a grid of display strings. Enough for the case lists
 * banks send (no formulas evaluated: the cached value Excel saved is read).
 */
export interface Sheet {
  name: string;
  rows: string[][];
}

const decode = (value: string) =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

const textOf = (xml: string) =>
  [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => decode(m[1] ?? "")).join("");

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/** Excel date serial → yyyy-mm-dd (only for cells styled as dates). */
function serialDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

export function readXlsx(bytes: Uint8Array): Sheet[] {
  const files = unzipSync(bytes, { filter: (file) => file.name.startsWith("xl/") });
  const text = (name: string) => (files[name] ? strFromU8(files[name]!) : "");
  const shared = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1] ?? ""));

  // Which number formats are dates, to show serials as dates.
  const styles = text("xl/styles.xml");
  const customDate = new Set(
    [...styles.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)]
      .filter((m) => /[dmy]/i.test((m[2] ?? "").replace(/\[[^\]]*\]|"[^"]*"/g, "")))
      .map((m) => Number(m[1])),
  );
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  const dateStyle = [...xfs.matchAll(/<xf\b([^>]*)\/?>/g)].map((m) => {
    const id = Number(/numFmtId="(\d+)"/.exec(m[1] ?? "")?.[1] ?? 0);
    return (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || customDate.has(id);
  });

  const workbook = text("xl/workbook.xml");
  const rels = text("xl/_rels/workbook.xml.rels");
  const targets = new Map(
    [...rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]),
  );
  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)) {
    const target = (targets.get(m[2]) ?? "").replace(/^\/?(xl\/)?/, "");
    const xml = text(`xl/${target}`);
    if (!xml) continue;
    const rows: string[][] = [];
    for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells: string[] = [];
      for (const cell of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1] ?? "";
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const type = /t="(\w+)"/.exec(attrs)?.[1];
        const style = Number(/s="(\d+)"/.exec(attrs)?.[1] ?? -1);
        const inner = cell[2] ?? "";
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value = "";
        if (type === "s") value = shared[Number(raw)] ?? "";
        else if (type === "inlineStr") value = textOf(inner);
        else if (type === "str" || type === "e") value = decode(raw ?? "");
        else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
        else if (raw !== undefined) {
          const number = Number(raw);
          value = style >= 0 && dateStyle[style] && Number.isFinite(number) ? serialDate(number) : raw;
          // 14-digit IDs saved as numbers come back as 2.9e13: write them out in full.
          if (/e\+?\d+$/i.test(value) && Number.isFinite(number)) value = BigInt(Math.round(number)).toString();
        }
        const index = ref ? columnIndex(ref) : cells.length;
        while (cells.length < index) cells.push("");
        cells[index] = value.trim();
      }
      rows.push(cells);
    }
    sheets.push({ name: decode(m[1] ?? ""), rows });
  }
  return sheets;
}

/** The plain text of a .docx (paragraphs and table cells, one per line). */
export function docxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (file) => file.name === "word/document.xml" });
  const xml = files["word/document.xml"] ? strFromU8(files["word/document.xml"]!) : "";
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>|<w:br\/>|<\/w:tc>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((line) => decode(line).trim())
    .filter(Boolean)
    .join("\n");
}
