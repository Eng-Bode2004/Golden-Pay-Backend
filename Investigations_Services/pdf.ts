/**
 * The standard Golden Pay report layout, used when a client has no approved Word layout
 * (or no Word engine is installed). Rendered by headless Chrome, which shapes Arabic and
 * lays out right-to-left text correctly.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStoredFile } from "../IdentityAcess_Services/Utils/files.ts";
import {
  type EvidenceContext,
  type FieldDef,
  isFilled,
  missingEvidence,
  sectionVisible,
  type TemplateDefinition,
  upgradeLegacy,
  evaluate,
} from "../Shared/templates/definition.ts";
import { formatValue } from "../Shared/templates/render.ts";
import { goldenPayStamp } from "../Shared/templates/report.ts";
import { logoAspect, logoOutline } from "./logo.ts";

export interface ReportData {
  reference: string;
  subject_name: string;
  subject_phone: string | null;
  client_reference: string | null;
  client_name: string;
  form_title: string;
  address: string;
  location: string;
  landmark: string | null;
  admin_notes: string | null;
  investigator: string;
  employee_number: string | null;
  submitted_at: Date;
  submit_lat: number | null;
  submit_lng: number | null;
  /** A v2 definition, or the old list of sections. */
  definition: TemplateDefinition | unknown[];
  answers: Record<string, unknown>;
  images: { field_key: string; path: string; created_at: Date }[];
  /** Pictures given directly (previews), by field key. */
  imageBytes?: Record<string, Uint8Array[]>;
  outcome: string;
  negative_reasons: string[];
  negative_note: string | null;
  trail: { kind: string; lat: number; lng: number; created_at: Date }[];
  evidence: EvidenceContext;
  approved: boolean;
}

const TRAIL_LABEL: Record<string, string> = {
  accepted: "عند القبول",
  started: "عند بدء الاستعلام",
  draft: "أثناء الاستعلام",
  photo: "عند التقاط صورة",
  submitted: "عند إرسال التقرير",
};

const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string,
  );

export function chromePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error("Chrome was not found. Set CHROME_PATH to enable PDF reports.");
  return found;
}

const mime = (path: string) => (path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg");
const uri = (bytes: Uint8Array, type: string) => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

function logoSvg(): string {
  const points = logoOutline
    .map((value, index) => (index % 2 ? (value * 100) / logoAspect : value * 100).toFixed(2))
    .join(" ");
  return `<svg viewBox="0 0 100 ${100 / logoAspect}" class="logo"><defs><linearGradient id="g" x1=".1" y1="0" x2=".9" y2="1">
    <stop offset="0" stop-color="#e9cf8f"/><stop offset=".45" stop-color="#b98f43"/><stop offset="1" stop-color="#8c6a2e"/>
    </linearGradient></defs><polygon fill="url(#g)" points="${points}"/></svg>`;
}

const dateTime = (value: Date) =>
  new Intl.DateTimeFormat("ar-EG", { dateStyle: "long", timeStyle: "short", timeZone: "Africa/Cairo" }).format(value);

function definitionOf(value: TemplateDefinition | unknown[]): TemplateDefinition {
  return Array.isArray(value) ? upgradeLegacy(value) : value;
}

export async function renderHtml(report: ReportData): Promise<string> {
  const fontDir = join(import.meta.dir, "Assets", "fonts");
  const regular = uri(new Uint8Array(await readFile(join(fontDir, "plex-arabic-regular.ttf"))), "font/ttf");
  const bold = uri(new Uint8Array(await readFile(join(fontDir, "plex-arabic-bold.ttf"))), "font/ttf");
  const definition = definitionOf(report.definition);

  const photosByField = new Map<string, string[]>();
  for (const image of report.images) {
    const bytes = await getStoredFile(image.path);
    photosByField.set(image.field_key, [...(photosByField.get(image.field_key) ?? []), uri(bytes, mime(image.path))]);
  }
  for (const [key, list] of Object.entries(report.imageBytes ?? {})) {
    photosByField.set(key, [...(photosByField.get(key) ?? []), ...list.map((bytes) => uri(bytes, bytes[0] === 0x89 ? "image/png" : "image/jpeg"))]);
  }

  const answers = report.answers;
  const row = (field: FieldDef) => {
    const value = answers[field.key];
    if (field.type === "attestation") {
      // A statement prints only when confirmed and backed by recorded evidence.
      if (value !== true) return "";
      if (missingEvidence(field, answers, report.evidence).length) return "";
      return `<tr><td colspan="2" class="statement">✓ ${escape(field.statement ?? field.label)}</td></tr>`;
    }
    if (field.type === "table") {
      const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
      if (!rows.length) return "";
      const columns = field.columns ?? [];
      return `<tr><td colspan="2" class="long"><b>${escape(field.label)}</b><table class="grid"><tr>${columns
        .map((column) => `<th>${escape(column.label)}</th>`)
        .join("")}</tr>${rows
        .map((item) => `<tr>${columns.map((column) => `<td>${escape(formatValue(column, item[column.key]))}</td>`).join("")}</tr>`)
        .join("")}</table></td></tr>`;
    }
    if (!isFilled(value)) return "";
    const text = formatValue(field, value);
    return field.type === "textarea"
      ? `<tr><td colspan="2" class="long"><b>${escape(field.label)}</b><p>${escape(text)}</p></td></tr>`
      : `<tr><th>${escape(field.label)}</th><td>${escape(text)}</td></tr>`;
  };

  const sections = definition.sections
    .filter((section) => sectionVisible(section, answers))
    .map((section) => {
      const rows: string[] = [];
      const photos: string[] = [];
      for (const field of section.fields) {
        if (!evaluate(field.visible_if, answers)) continue;
        if (field.type === "photos" || field.type === "signature") {
          const uris = photosByField.get(field.key) ?? [];
          if (uris.length) {
            photos.push(
              `<h3>${escape(field.label)}</h3><div class="${field.type === "signature" ? "signature" : "photos"}">${uris
                .map((src) => `<figure><img src="${src}"/></figure>`)
                .join("")}</div>`,
            );
          }
          continue;
        }
        const html = row(field);
        if (html) rows.push(html);
      }
      if (!rows.length && !photos.length) return "";
      return `<section><h2>${escape(section.title)}</h2>${rows.length ? `<table>${rows.join("")}</table>` : ""}${photos.join("")}</section>`;
    })
    .join("");

  const gps =
    report.submit_lat !== null
      ? `<a href="https://maps.google.com/?q=${report.submit_lat},${report.submit_lng}">${report.submit_lat.toFixed(5)}, ${report.submit_lng?.toFixed(5)}</a>`
      : "غير متوفر";
  const stamp = report.approved ? `<img class="stamp" src="${uri(await goldenPayStamp(), "image/png")}"/>` : "";

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
    @font-face{font-family:Plex;src:url(${regular});font-weight:400}
    @font-face{font-family:Plex;src:url(${bold});font-weight:700}
    @page{size:A4;margin:14mm 13mm}
    :root{color-scheme:light}
    *{box-sizing:border-box}
    html,body{background:#fff}
    body{margin:0;font:400 11pt/1.65 Plex,sans-serif;color:#1d1a15;-webkit-print-color-adjust:exact}
    header{display:flex;align-items:center;gap:14px;padding:16px 20px;border-radius:12px;color:#fbf5e6;
      background:linear-gradient(120deg,#14100a,#2c2212 70%,#4a3614)}
    .logo{width:44px}
    header h1{margin:0;font-size:17pt;color:#f0d9a0}
    header small{display:block;opacity:.85;font-size:9.5pt}
    header .ref{margin-inline-start:auto;text-align:left;font-size:10pt;direction:ltr}
    .summary{display:grid;grid-template-columns:1fr 1fr;gap:6px 22px;margin:14px 0;padding:12px 16px;
      background:#faf5e8;border:1px solid #e6d7b3;border-radius:10px;font-size:10.5pt}
    .summary b{color:#7a5c22;margin-inline-end:6px}
    .wide{grid-column:1/3}
    section{margin-top:14px}
    h2{margin:0 0 6px;padding-bottom:4px;font-size:12.5pt;color:#7a5c22;border-bottom:2px solid #d9b46a;break-after:avoid}
    h3{margin:10px 0 6px;font-size:11pt;color:#7a5c22;break-after:avoid}
    table{width:100%;border-collapse:collapse}
    tr{break-inside:avoid}
    th,td{padding:5px 9px;border:1px solid #e8dfca;text-align:right;vertical-align:top}
    th{width:38%;background:#fbf8f0;font-weight:700;font-size:10pt}
    .grid th{width:auto}
    .grid{margin-top:6px}
    .statement{background:#f6faf3;color:#2f4a22}
    .long p{margin:3px 0 0;white-space:pre-wrap}
    .photos{display:grid;grid-template-columns:1fr 1fr;gap:9px}
    .signature figure{width:220px;border:none}
    .signature img{height:90px;object-fit:contain}
    figure{margin:0;break-inside:avoid;border:1px solid #e6d7b3;border-radius:8px;overflow:hidden}
    figure img{display:block;width:100%;height:230px;object-fit:cover}
    footer{margin-top:18px;padding-top:10px;border-top:2px solid #d9b46a;display:grid;
      grid-template-columns:1fr 1fr;gap:4px 22px;font-size:10pt;break-inside:avoid;position:relative}
    footer b{color:#7a5c22;margin-inline-end:6px}
    .stamp{position:absolute;left:0;top:-6px;width:110px;opacity:.92}
    a{color:#7a5c22}
    .negative{padding:12px 16px;border-radius:10px;background:#fdf1ef;border:1px solid #e9b8ad}
    .negative h2{color:#a33a22;border-color:#e9b8ad}
    .negative ul{margin:6px 0;padding-inline-start:20px}
    .negative p{margin:6px 0 0;white-space:pre-wrap}
  </style></head><body>
    <header>${logoSvg()}<div><h1>جولدن باي للخدمات</h1><small>تقرير ${escape(report.form_title)} — ${escape(report.client_name)}</small></div>
      <div class="ref">${escape(report.reference)}</div></header>
    <div class="summary">
      <div><b>المستعلم عنه:</b>${escape(report.subject_name)}</div>
      <div><b>الهاتف:</b><bdi>${escape(report.subject_phone ?? "—")}</bdi></div>
      <div class="wide"><b>العنوان:</b>${escape(report.address)}</div>
      ${report.location ? `<div class="wide"><b>المنطقة:</b>${escape(report.location)}</div>` : ""}
      ${report.landmark ? `<div class="wide"><b>علامة مميزة:</b>${escape(report.landmark)}</div>` : ""}
      ${report.client_reference ? `<div><b>مرجع العميل:</b><bdi>${escape(report.client_reference)}</bdi></div>` : ""}
    </div>
    ${
      report.outcome === "negative"
        ? `<section class="negative"><h2>استعلام سلبي — لم يتم العثور على الشخص</h2>
            <ul>${report.negative_reasons.map((reason) => `<li>${escape(reason)}</li>`).join("")}</ul>
            <p>${escape(report.negative_note)}</p></section>`
        : ""
    }
    ${sections}
    ${
      report.trail.length
        ? `<section><h2>مواقع المستعلم أثناء الاستعلام</h2><table>${report.trail
            .map(
              (point) =>
                `<tr><th>${escape(TRAIL_LABEL[point.kind] ?? point.kind)} — ${dateTime(new Date(point.created_at))}</th>
                 <td><a href="https://maps.google.com/?q=${point.lat},${point.lng}">${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}</a></td></tr>`,
            )
            .join("")}</table></section>`
        : ""
    }
    <footer>
      ${stamp}
      <div><b>المستعلم:</b>${escape(report.investigator)}</div>
      <div><b>الرقم الوظيفي:</b><bdi>${escape(report.employee_number ?? "—")}</bdi></div>
      <div><b>تاريخ الإرسال:</b>${dateTime(report.submitted_at)}</div>
      <div><b>موقع الزيارة:</b>${gps}</div>
    </footer>
  </body></html>`;
}

/** Prints HTML to PDF with headless Chrome and returns the bytes. */
export async function htmlToPdf(html: string): Promise<Uint8Array> {
  const workDir = join(tmpdir(), `gp-pdf-${crypto.randomUUID()}`);
  await mkdir(workDir, { recursive: true });
  const htmlPath = join(workDir, "report.html");
  const output = join(workDir, "report.pdf");
  await writeFile(htmlPath, html);
  try {
    // A busy machine can make Chrome exit early, so a retry is worthwhile.
    let failure = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const chrome = Bun.spawn(
        [
          chromePath(),
          "--headless=new",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--no-sandbox",
          "--no-first-run",
          "--no-pdf-header-footer",
          `--user-data-dir=${join(workDir, `profile-${attempt}`)}`,
          `--print-to-pdf=${output}`,
          `file:///${htmlPath.replace(/\\/g, "/")}`,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const timeout = setTimeout(() => chrome.kill(), 60_000);
      const stderr = await new Response(chrome.stderr).text();
      const code = await chrome.exited;
      clearTimeout(timeout);
      if (await Bun.file(output).exists()) return new Uint8Array(await readFile(output));
      failure = `exit ${code}: ${stderr.slice(-300)}`;
      await Bun.sleep(1500 * attempt);
    }
    throw new Error(`Chrome did not produce a PDF (${failure})`);
  } finally {
    await rm(workDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

export async function renderStandardPdf(report: ReportData): Promise<Uint8Array> {
  return htmlToPdf(await renderHtml(report));
}
