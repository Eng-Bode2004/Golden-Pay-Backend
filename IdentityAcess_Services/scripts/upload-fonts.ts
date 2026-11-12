// Copies the Windows fonts client Word forms use into the private bucket (private-fonts/),
// with a manifest. The server downloads them at startup (start.ts) so LibreOffice draws the
// clients' layouts with the same letter widths as Word. The font files are licensed with
// the company's Windows and must never be committed to the repository.
//   bun --env-file=.env scripts/upload-fonts.ts [fonts folder, default C:\Windows\Fonts]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { putStoredFile, usesCloudStorage } from "../Utils/files.ts";

const FONTS = [
  // Arial (also stands in for "Arabic Transparent", as Windows does)
  "arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf",
  "times.ttf", "timesbd.ttf", "timesi.ttf", "timesbi.ttf",
  "calibri.ttf", "calibrib.ttf", "calibrii.ttf", "calibriz.ttf", "calibril.ttf", "calibrili.ttf",
  "cambria.ttc", "cambriab.ttf", "cambriai.ttf", "cambriaz.ttf",
  "tahoma.ttf", "tahomabd.ttf",
  "simpo.ttf", "simpbdo.ttf", "simpfxo.ttf",
  "trado.ttf", "tradbdo.ttf",
  "segoeui.ttf", "segoeuib.ttf", "segoeuii.ttf", "segoeuiz.ttf",
  // Box and tick characters: ☐ ☒ ✓ and Wingdings symbols.
  "seguisym.ttf", "msgothic.ttc", "wingding.ttf", "WINGDNG2.TTF", "WINGDNG3.TTF", "symbol.ttf",
];

if (!usesCloudStorage()) throw new Error("Set STORAGE_BUCKET and its keys in .env first");
const folder = process.argv[2] ?? "C:\\Windows\\Fonts";
const uploaded: string[] = [];
for (const name of FONTS) {
  const path = join(folder, name);
  if (!existsSync(path)) {
    console.log(`missing ${name}, skipped`);
    continue;
  }
  await putStoredFile(`private-fonts/${name.toLowerCase()}`, new Uint8Array(readFileSync(path)), "application/octet-stream");
  uploaded.push(name.toLowerCase());
  console.log(`uploaded ${name}`);
}
await putStoredFile("private-fonts/manifest.json", new TextEncoder().encode(JSON.stringify({ fonts: uploaded }, null, 2)), "application/json");
console.log(`${uploaded.length} fonts uploaded; restart the backend to load them`);
