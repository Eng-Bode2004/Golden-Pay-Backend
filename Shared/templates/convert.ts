/**
 * Turns Word files into PDF (and legacy .doc into .docx) with a real Word engine, so the
 * client's layout, Arabic shaping, tables and page breaks come out as designed.
 *
 *   REPORT_CONVERTER=libreoffice | word | auto (default)
 *   SOFFICE_PATH=/usr/bin/soffice   (LibreOffice; the usual choice on a Linux server)
 *
 * Word is used on Windows machines that have Microsoft Office. Every conversion runs in
 * its own process with a timeout, one at a time, because both engines dislike sharing.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocxPackage, type El, descendants } from "./docx.ts";

export type Engine = "libreoffice" | "word";

const WORD_SCRIPT = join(import.meta.dir, "word-convert.ps1");
const TIMEOUT_MS = Number(process.env.REPORT_CONVERT_TIMEOUT_MS ?? 120_000);
// Each LibreOffice conversion gets its own profile (so a stuck or crashed run can never block
// the next one), copied from a ready-made one: building a profile from nothing costs
// several seconds.
const SEED_PROFILE = join(tmpdir(), "gp-libreoffice-seed");

/** The request that wanted this conversion went away before its turn came. */
export class ConversionCancelled extends Error {
  constructor() {
    super("The conversion was cancelled");
  }
}

function sofficePath(): string | null {
  const candidates = [
    process.env.SOFFICE_PATH,
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/usr/local/bin/soffice",
    "/opt/libreoffice/program/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "C:/Program Files/LibreOffice/program/soffice.exe",
    "C:/Program Files (x86)/LibreOffice/program/soffice.exe",
  ];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

// Called by full path so the service works whatever PATH it was started with.
const POWERSHELL = join(process.env.SystemRoot ?? process.env.windir ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

let wordAvailable = false;
async function hasWord(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  // Only a positive answer is remembered: a failed check is tried again next time.
  if (wordAvailable) return true;
  try {
    const probe = Bun.spawn(
      [POWERSHELL, "-NoProfile", "-Command", "if (Test-Path 'Registry::HKEY_CLASSES_ROOT\\Word.Application\\CLSID') { 'yes' } else { 'no' }"],
      { stdout: "pipe", stderr: "ignore" },
    );
    wordAvailable = (await new Response(probe.stdout).text()).trim() === "yes";
  } catch {
    wordAvailable = false;
  }
  return wordAvailable;
}

/** Which engine will be used, or null when none is installed. */
export async function availableEngine(): Promise<Engine | null> {
  const wanted = (process.env.REPORT_CONVERTER ?? "auto").toLowerCase();
  if (wanted === "libreoffice") return sofficePath() ? "libreoffice" : null;
  if (wanted === "word") return (await hasWord()) ? "word" : null;
  if (sofficePath()) return "libreoffice";
  if (await hasWord()) return "word";
  return null;
}

// One conversion at a time: Word automation and LibreOffice profiles are not concurrent-safe.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

async function run(command: string[], label: string): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${label} failed (exit ${code}): ${(stderr || stdout).trim().slice(-400)}`);
  return stdout;
}

async function convert(
  bytes: Uint8Array,
  from: "docx" | "doc" | "pdf",
  to: "pdf" | "docx",
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; pages: number | null; engine: Engine }> {
  const engine = await availableEngine();
  if (!engine) throw new ConverterUnavailable();
  return serial(async () => {
    // A preview nobody waits for any more does not hold up the ones behind it.
    if (signal?.aborted) throw new ConversionCancelled();
    const dir = join(tmpdir(), `gp-convert-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const input = join(dir, `input.${from}`);
    const output = join(dir, `input.${to}`);
    await writeFile(input, engine === "libreoffice" && from === "docx" ? drawablePageBorders(bytes) : bytes);
    try {
      let pages: number | null = null;
      if (engine === "word") {
        const out = await run(
          [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WORD_SCRIPT, input, output, to],
          "Word conversion",
        );
        pages = Number(/pages=(\d+)/.exec(out)?.[1] ?? NaN) || null;
      } else {
        const filter = to === "pdf" ? "pdf:writer_pdf_Export" : "docx:MS Word 2007 XML";
        const profile = join(dir, "profile");
        const seeded = existsSync(SEED_PROFILE) && (await cp(SEED_PROFILE, profile, { recursive: true }).then(() => true, () => false));
        try {
          await run(
            [
              sofficePath()!,
              `-env:UserInstallation=file:///${profile.replace(/\\/g, "/")}`,
              "--headless",
              "--norestore",
              "--convert-to",
              filter,
              "--outdir",
              dir,
              input,
            ],
            "LibreOffice conversion",
          );
        } finally {
          // LibreOffice's real worker (soffice.bin) can outlive a launcher that was stopped;
          // whatever still runs for this conversion is ended, so nothing piles up in memory.
          await killLeftovers(dir);
        }
        if (existsSync(output) && !seeded && !existsSync(SEED_PROFILE)) {
          await cp(profile, SEED_PROFILE, { recursive: true }).catch(() => rm(SEED_PROFILE, { recursive: true, force: true }).catch(() => {}));
        } else if (!existsSync(output) && seeded) {
          // A damaged ready-made profile: drop it; the next conversion builds a new one.
          await rm(SEED_PROFILE, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
        }
      }
      if (!existsSync(output)) throw new Error(`${engine} produced no ${to} file`);
      const result = new Uint8Array(await readFile(output));
      if (to === "pdf" && pages === null) pages = countPdfPages(result);
      return { bytes: result, pages, engine };
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  });
}

/** Page border styles LibreOffice can draw; any other value is a Word "art" border. */
const LINE_BORDERS = new Set([
  "nil", "none", "single", "thick", "double", "dotted", "dashed", "dotDash", "dotDotDash", "triple",
  "thinThickSmallGap", "thickThinSmallGap", "thinThickThinSmallGap", "thinThickMediumGap", "thickThinMediumGap",
  "thinThickThinMediumGap", "thinThickLargeGap", "thickThinLargeGap", "thinThickThinLargeGap", "wave", "doubleWave",
  "dashSmallGap", "dashDotStroked", "threeDEmboss", "threeDEngrave", "outset", "inset",
]);

/**
 * Word "art" page borders (twisted lines, corner triangles…) are not drawn by LibreOffice, so
 * the frame vanished from CIB's reports. Before converting, each one becomes a thick-thin
 * double line in deep blue, the nearest frame LibreOffice draws. The template is untouched.
 */
export function drawablePageBorders(bytes: Uint8Array): Uint8Array {
  let pkg: DocxPackage;
  try {
    pkg = DocxPackage.open(bytes);
  } catch {
    return bytes;
  }
  let changed = false;
  for (const borders of descendants(pkg.xml("word/document.xml").documentElement as El, "pgBorders")) {
    for (const side of Array.from(borders.childNodes).filter((node) => node.nodeType === 1) as El[]) {
      const value = side.getAttribute("w:val") ?? "";
      if (!value || LINE_BORDERS.has(value)) continue;
      side.setAttribute("w:val", "thickThinSmallGap");
      side.setAttribute("w:sz", "24");
      if ((side.getAttribute("w:color") ?? "auto") === "auto") side.setAttribute("w:color", "1F3A93");
      changed = true;
    }
  }
  return changed ? pkg.save() : bytes;
}

/** Ends every process whose command line mentions `marker` (Linux; elsewhere nothing to do). */
async function killLeftovers(marker: string): Promise<void> {
  if (process.platform !== "linux") return;
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid);
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      const cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
      if (cmdline.includes(marker)) process.kill(Number(pid), "SIGKILL");
    } catch {
      // The process already ended, or belongs to someone else.
    }
  }
}

export class ConverterUnavailable extends Error {
  constructor() {
    super("No Word engine is installed. Install LibreOffice (set SOFFICE_PATH) or Microsoft Word to keep client layouts.");
  }
}

export const docxToPdf = (bytes: Uint8Array, signal?: AbortSignal) => convert(bytes, "docx", "pdf", signal);
export const docToDocx = (bytes: Uint8Array) => convert(bytes, "doc", "docx");
/** Word can turn a PDF into an editable document; LibreOffice cannot do this well. */
export const pdfToDocx = (bytes: Uint8Array) => convert(bytes, "pdf", "docx");

/** Page count from the PDF's page tree, good enough for layout checks. */
export function countPdfPages(pdf: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(pdf);
  const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)].map((match) => Number(match[1]));
  if (counts.length) return Math.max(...counts);
  return (text.match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length;
}
