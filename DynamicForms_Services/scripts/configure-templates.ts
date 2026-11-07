// Completes the configuration of every imported client template (all files in
// "Investigation Forms"), then sends each one that has nothing left for Head Office to
// decide to review. Head Office still approves and activates; nothing is activated here.
//
//   bun --env-file=../IdentityAcess_Services/.env scripts/configure-templates.ts [--dry] [filter]
//
// Only drafts created by the importer and never edited by a person are touched. What it
// does, per template:
//  1. Places the layout gives no label for (floating frames, drawn squares) and weak labels
//     ("بيان", "%", "x"…) are named from the page itself: each place gets a marker, the
//     layout is rendered by Word, and the words printed next to the marker become its label.
//  2. Drawn squares become checkbox options of the question on their line.
//  3. Pictures and text left from real reports are verified as removed or replaced, and
//     the matching warnings are recorded as resolved.
//  4. Client or type warnings that the documents cannot settle stay open for Head Office.
//  5. Templates with no remaining blocker go to review (submitted by "system").
import { readFileSync, writeFileSync } from "node:fs";
import { connectDatabase, database, query } from "../../IdentityAcess_Services/Config/db.ts";
import { docxToPdf } from "../../Shared/templates/convert.ts";
import { allFields, type FieldDef, type FieldType, parseDefinition, type TemplateDefinition } from "../../Shared/templates/definition.ts";
import { ancestor, attr, children, descendants, DocxPackage, type El, md5, NS, textOf } from "../../Shared/templates/docx.ts";
import { INVESTIGATION_TYPES, type InventoryRecord, type InventoryWarning } from "../../Shared/templates/inventory.ts";
import { renderTemplate, writeInsideShape } from "../../Shared/templates/render.ts";
import { type Binding, CANON, foldHamza, normalizeLabel, type Slot, typeFor } from "../../Shared/templates/scan.ts";
import { sampleAnswers } from "../../Shared/templates/report.ts";
import { checkVersion, contentHash, loadFile, logTemplateEvent } from "../templates.ts";

const DRY = process.argv.includes("--dry");
const FILTER = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "";
const OVERRIDES = JSON.parse(
  readFileSync(new URL("../Seeds/template-overrides.json", import.meta.url), "utf8"),
) as Record<string, { labels?: Record<string, string>; clear?: string[]; notes?: string[]; types?: Record<string, FieldType> }>;

type Row = Record<string, unknown>;
type Item = { str: string; x: number; y: number; w: number; page: number };

const WEAK_WORDS = /^(بيان|مربع نص فارغ|حقل|صورة|و|عن|من|في|ة|جم|ات|تق|لا|نعم|رقم|تاريخ|إلى|الى|إن وجد|ان وجد)$/;
export function isWeak(label: string): boolean {
  const clean = label.replace(/[()"'«»\-–ـ.:：/\\]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length < 3 || WEAK_WORDS.test(clean) || /^خيار \d+$/.test(clean) || /^[\d\s%x×]+$/.test(clean);
}

/** "تاريخ الإصدار: تاريخ التجديد : مكتب الإصدار" → "مكتب الإصدار"; "السجل التجاري: -رقم" → "السجل التجاري — رقم". */
function tidyLabel(label: string): string {
  const parts = label.split(/[:：]/).map((part) => part.replace(/^[\s\-–ـ.]+|[\s\-–ـ.(]+$/g, "").trim()).filter(Boolean);
  if (parts.length < 2) return label.replace(/[\s\-–ـ.(]+$/g, "").trim() || label;
  const last = parts[parts.length - 1]!;
  const before = parts[parts.length - 2]!;
  if (isWeak(last)) return /رقم|تاريخ|من|إلى/.test(last) ? `${before} — ${last.replace(/^-/, "")}` : before;
  return last;
}

// pdf.js reads the lam-alef ligature back as "ال"; compare words without that pair.
const fold = (value: string) => value.replace(/لا|ال|لأ|أل|لإ|إل|لآ|آل/g, "#").replace(/[ىي]/g, "ي").replace(/[ةه]/g, "ه").replace(/\s+/g, "");

/** Every phrase written in the document, to restore the exact spelling of labels read from the PDF. */
function documentPhrases(pkg: DocxPackage): Map<string, string> {
  const phrases = new Map<string, string>();
  for (const part of pkg.textParts()) {
    for (const paragraph of descendants(pkg.xml(part).documentElement as El, "p")) {
      const text = [textOf(paragraph), ...descendants(paragraph, "txbxContent").map((box) => box.textContent ?? "")].join("  ");
      for (const piece of text.split(/\s{2,}|[:：☐□]/)) {
        const phrase = normalizeLabel(piece);
        if (phrase.length >= 2) phrases.set(fold(phrase), phrase);
      }
    }
  }
  return phrases;
}

/** Size of the frame a bookmark sits in, in points; small squares are drawn checkboxes. */
function frameSize(pkg: DocxPackage, part: string, anchor: string): { w: number; h: number } | null {
  const mark = descendants(pkg.xml(part).documentElement as El, "bookmarkStart").find((el) => attr(el, "name") === anchor);
  if (!mark) return null;
  const box = ancestor(mark, "txbxContent");
  if (!box) return null;
  const drawing = ancestor(box, "drawing") ?? ancestor(box, "pict");
  const extent = drawing ? descendants(drawing, "extent", NS.wp)[0] : undefined;
  if (extent) return { w: Number(extent.getAttribute("cx")) / 12700, h: Number(extent.getAttribute("cy")) / 12700 };
  const shape = drawing ? [...descendants(drawing, "shape", NS.v), ...descendants(drawing, "rect", NS.v)][0] : undefined;
  const style = shape?.getAttribute("style") ?? "";
  const w = Number(/width:([\d.]+)pt/.exec(style)?.[1] ?? 0);
  const h = Number(/height:([\d.]+)pt/.exec(style)?.[1] ?? 0);
  return w && h ? { w, h } : null;
}

async function pdfItems(pdf: Uint8Array): Promise<Item[]> {
  const lib = await import("../../Shared/node_modules/pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await lib.getDocument({ data: pdf.slice(), isEvalSupported: false }).promise;
  const items: Item[] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const content = await (await doc.getPage(number)).getTextContent();
    for (const entry of content.items as { str: string; transform: number[]; width: number }[]) {
      if (entry.str.trim()) items.push({ str: entry.str, x: entry.transform[4]!, y: entry.transform[5]!, w: entry.width, page: number });
    }
  }
  return items;
}

/**
 * Renders the layout with a marker in each place and reads, for each marker, the words
 * printed right next to it: to its right on the same line (the page reads right to left),
 * or just above it for column headings.
 */
async function labelsFromPage(layout: Uint8Array, anchors: string[], phrases: Map<string, string>, squares: Set<string>) {
  // Squares get their marker drawn inside the shape (they float); frames and blanks get text.
  const prepared = DocxPackage.open(layout);
  anchors.forEach((anchor, index) => {
    if (!squares.has(anchor)) return;
    for (const part of prepared.textParts()) {
      const mark = descendants(prepared.xml(part).documentElement as El, "bookmarkStart").find((el) => attr(el, "name") === anchor);
      const run = mark?.nextSibling as El | null;
      if (run && run.nodeType === 1) writeInsideShape(run, `Q${index}Q`, 4);
    }
  });
  layout = prepared.save();
  const bindings: Binding[] = anchors
    .map((anchor, index) => ({ anchor, action: "text" as const, source: `case.m${index}` }))
    .filter((binding) => !squares.has(binding.anchor));
  const caseValues = Object.fromEntries(anchors.map((_, index) => [`m${index}`, `Q${index}Q`]));
  const docx = renderTemplate(layout, bindings, {
    definition: { schema: 2, sections: [] },
    answers: {},
    caseValues,
    images: {},
    evidence: { photos: {}, locations: [] },
  }).docx;
  // Markers in a 2-point font fit even inside the smallest drawn square.
  const marked = DocxPackage.open(docx);
  for (const part of marked.textParts()) {
    for (const run of descendants(marked.xml(part).documentElement as El, "r")) {
      if (!/^Q\d+Q$/.test(textOf(run).trim())) continue;
      const doc = run.ownerDocument!;
      let rPr = children(run, "rPr")[0];
      if (!rPr) rPr = run.insertBefore(doc.createElementNS(NS.w, "w:rPr"), run.firstChild) as El;
      for (const name of ["sz", "szCs"]) {
        for (const old of children(rPr, name)) rPr.removeChild(old);
        const size = doc.createElementNS(NS.w, `w:${name}`);
        size.setAttributeNS(NS.w, "w:val", "4");
        rPr.appendChild(size);
      }
    }
  }
  const items = await pdfItems((await docxToPdf(marked.save())).bytes);
  const result = new Map<string, { label: string; line: Item[]; marker: Item; raw: string }>();
  anchors.forEach((anchor, index) => {
    const marker = items.find((item) => new RegExp(`Q${index}Q`).test(item.str));
    if (!marker) return;
    const others = items.filter((item) => item !== marker && item.page === marker.page && !/Q\d+Q/.test(item.str));
    // A tiny marker sits at the top of its box; the label beside it is a little lower.
    const line = others.filter((item) => item.y >= marker.y - 16 && item.y <= marker.y + 6);
    const right = line.filter((item) => item.x >= marker.x + marker.w - 3).sort((a, b) => a.x - b.x);
    let words: string[] = [];
    if (right.length && right[0]!.x - (marker.x + marker.w) < 160) {
      words = [right[0]!.str];
      for (let next = 1; next < right.length && right[next]!.x - (right[next - 1]!.x + right[next - 1]!.w) < 8; next += 1) {
        words.push(right[next]!.str);
      }
      words.reverse();
    } else {
      const above = others
        .filter((item) => item.y > marker.y + 3 && item.y - marker.y < 30 && item.x < marker.x + 160 && item.x + item.w > marker.x - 40)
        .sort((a, b) => a.y - b.y);
      if (above[0]) words = [above[0].str];
    }
    let label = normalizeLabel(words.join(" "));
    label = phrases.get(fold(label)) ?? label;
    if (label) result.set(anchor, { label, line, marker, raw: words.join(" ") });
  });
  return result;
}

function canonicalFor(label: string) {
  const clean = normalizeLabel(label);
  return CANON.find((item) => item.test.test(foldHamza(clean)));
}

function newKey(label: string, anchor: string, taken: Set<string>): string {
  let key = `f_${md5(new TextEncoder().encode(`${label}#${anchor}`)).slice(0, 7)}`;
  while (taken.has(key)) key = `${key}x`;
  taken.add(key);
  return key;
}

const typeOf = (text: string) => INVESTIGATION_TYPES.find((type) => type.test.test(text))?.code ?? null;

const PERSONAL = new Set(["signature", "site_photo", "qr_code", "third_party_stamp", "embedded_screenshot"]);
const DATA_WARNINGS = new Set(["sample_text", "sample_date", "unknown_image", "scan", "tracked_changes", "comments", "legacy_format", "sensitivity_label", "shared_layout"]);

interface Outcome {
  path: string;
  client: string;
  type: string;
  fields: number;
  status: "in_review" | "needs_decision" | "skipped";
  decisions: string[];
  notes: string[];
  /** Questions with no place in the client's layout (printed in the report appendix). */
  unplaced: string[];
  /** Places in the layout left as in the original (no question bound to them). */
  unbound_places: number;
}

async function configure(row: Row): Promise<Outcome> {
  const path = String(row.source_path);
  const override = OVERRIDES[path] ?? {};
  const inventory = row.inventory as InventoryRecord;
  const definition = structuredClone(row.definition) as TemplateDefinition;
  let bindings = structuredClone(row.bindings) as Binding[];
  const slots = row.slots as Slot[];
  const layout = await loadFile(row.layout_path as string);
  const pkg = DocxPackage.open(layout);
  const notes: string[] = [];
  const fields = () => new Map(allFields(definition).map((field) => [field.key, field]));
  const taken = new Set(allFields(definition).map((field) => field.key));
  const bindingOf = (anchor: string) => bindings.find((binding) => binding.anchor === anchor);
  const sectionFor = (title: string) => {
    let section = definition.sections.find((item) => item.title === title);
    if (!section) {
      section = { id: `s${definition.sections.length + 1}_${md5(new TextEncoder().encode(title)).slice(0, 4)}`, title, fields: [] };
      definition.sections.push(section);
    }
    return section;
  };

  // ── 1. Tidy labels the scanner joined together ──
  for (const field of allFields(definition)) {
    if (field.type === "attestation") continue;
    const tidy = tidyLabel(field.label);
    if (tidy !== field.label && !isWeak(tidy)) field.label = tidy;
  }

  // ── 2. Name places from the page ──
  const rowAnchors = new Set(slots.flatMap((slot) => slot.rows?.anchors.slice(1) ?? []));
  const unlabeledBoxes = slots.filter(
    (slot) => ((slot.kind === "cell" && slot.label === "مربع نص فارغ") || (slot.kind === "checkbox" && slot.label === "مربع اختيار")) && !bindingOf(slot.anchor),
  );
  const weakFields = new Set(allFields(definition).filter((field) => field.type !== "attestation" && isWeak(field.label)).map((field) => field.key));
  const weakAnchors = bindings
    .filter((binding) => binding.action === "text" && binding.source && weakFields.has(binding.source.slice(8)) && !rowAnchors.has(binding.anchor))
    .map((binding) => binding.anchor);
  const targets = [...new Set([...unlabeledBoxes.map((slot) => slot.anchor), ...weakAnchors])];
  if (targets.length) {
    const squareSet = new Set(unlabeledBoxes.filter((slot) => slot.kind === "checkbox").map((slot) => slot.anchor));
    const found = await labelsFromPage(layout, targets, documentPhrases(pkg), squareSet);
    if (process.env.VERBOSE) for (const anchor of targets) console.log(`   ${anchor} → ${found.get(anchor)?.label ?? "؟"}`);
    // Drawn squares on a line become one question with an option per square.
    const squares = unlabeledBoxes.filter((slot) => {
      if (slot.kind === "checkbox") return true;
      const size = frameSize(pkg, slot.part, slot.anchor);
      return size && size.w < 24 && size.h < 24 && Math.abs(size.w - size.h) < 9;
    });
    const phrases = documentPhrases(pkg);
    const spell = (text: string) => phrases.get(fold(normalizeLabel(text))) ?? normalizeLabel(text);
    // Squares are grouped by line: same page, baselines within 6 points.
    const placed = squares
      .map((slot) => ({ slot, hit: found.get(slot.anchor) }))
      .filter((item): item is { slot: Slot; hit: NonNullable<ReturnType<typeof found.get>> } => Boolean(item.hit))
      .sort((a, b) => a.hit.marker.page - b.hit.marker.page || b.hit.marker.y - a.hit.marker.y);
    const groups: (typeof placed)[] = [];
    for (const item of placed) {
      const last = groups[groups.length - 1];
      const head = last?.[0]?.hit.marker;
      if (head && head.page === item.hit.marker.page && Math.abs(head.y - item.hit.marker.y) <= 6) last!.push(item);
      else groups.push([item]);
    }
    const squareAnchors = new Set<string>();
    for (const group of groups) {
      // The question is the rightmost text on the line ("وسيلة التأكد من السكن:").
      const rightmost = [...group[0]!.hit.line].sort((a, b) => b.x - a.x)[0];
      const question = spell((rightmost?.str ?? "").split(/[:：]/)[0] ?? "") || group[0]!.slot.section;
      const chosen = new Map<string, Slot>();
      for (const { slot, hit } of group) {
        // "تليفون السكن: صحيح" → option "صحيح"; a bare label ("العلاقة القانونية:") is not an option.
        const raw = hit.raw.trim();
        const afterColon = /[:：]/.test(raw) ? raw.split(/[:：]/).pop()!.trim() : raw;
        const option = spell(afterColon);
        if (!option || isWeak(option) || option === question || /[:：]\s*$/.test(raw)) continue;
        if (!chosen.has(option)) chosen.set(option, slot);
      }
      if (!chosen.size) continue;
      const options = [...chosen.keys()];
      const exclusive = options.length <= 3 || options.every((option) => /^(نعم|لا|صحيح|خطأ|خطا|يوجد|لا يوجد)$/.test(option));
      const key = newKey(question, group[0]!.slot.anchor, taken);
      sectionFor(group[0]!.slot.section).fields.push({ key, label: question, type: exclusive ? "choice" : "multichoice", options });
      for (const [option, slot] of chosen) {
        bindings.push({ anchor: slot.anchor, action: "check", source: `answers.${key}`, option });
        squareAnchors.add(slot.anchor);
      }
    }
    // Remaining frames: a value written after the label printed beside them.
    // A whitespace gap after a label, where the floating frame actually sits: the frame
    // is the true place, so the gap's binding is removed and its question is reused.
    const gapSlots = new Set(slots.filter((slot) => slot.kind === "inline" && !slot.text.trim()).map((slot) => slot.anchor));
    const sameLabel = (a: string, b: string) => fold(tidyLabel(a).replace(/\s*\(\d+\)$/, "")) === fold(tidyLabel(b).replace(/\s*\(\d+\)$/, ""));
    const takeOverGap = (label: string, source?: string): string | null => {
      const gap = bindings.find((binding) => {
        if (!gapSlots.has(binding.anchor) || binding.action !== "text" || !binding.source) return false;
        if (source && binding.source === source) return true;
        const field = binding.source.startsWith("answers.") ? fields().get(binding.source.slice(8)) : undefined;
        return Boolean(field && sameLabel(field.label, label));
      });
      if (!gap) return null;
      bindings = bindings.filter((binding) => binding !== gap);
      return gap.source!;
    };
    for (const slot of unlabeledBoxes) {
      if (squareAnchors.has(slot.anchor)) continue;
      const label = override.labels?.[slot.anchor] ?? found.get(slot.anchor)?.label;
      if (!label || isWeak(label)) continue;
      const canon = canonicalFor(tidyLabel(label));
      if (canon?.source) {
        takeOverGap(label, canon.source);
        bindings.push({ anchor: slot.anchor, action: "text", source: canon.source });
        continue;
      }
      const reused = takeOverGap(label, canon?.key ? `answers.${canon.key}` : undefined);
      if (reused) {
        bindings.push({ anchor: slot.anchor, action: "text", source: reused });
        continue;
      }
      const existing = canon?.key && fields().get(canon.key);
      const key = existing ? canon!.key! : newKey(label, slot.anchor, taken);
      if (!existing) {
        sectionFor(slot.section).fields.push({
          key,
          label,
          type: override.types?.[slot.anchor] ?? canon?.type ?? typeFor(label),
          ...(canon?.prefill && key === canon.key ? { prefill: canon.prefill } : {}),
        });
      }
      bindings.push({ anchor: slot.anchor, action: "text", source: `answers.${key}` });
    }
    // Weak labels on existing questions.
    for (const anchor of weakAnchors) {
      const binding = bindingOf(anchor);
      const field = binding?.source ? fields().get(binding.source.slice(8)) : undefined;
      const label = override.labels?.[anchor] ?? found.get(anchor)?.label;
      if (field && label && !isWeak(label)) field.label = label;
    }
    notes.push(`سُمّيت ${found.size} خانة من موضعها في الصفحة`);
  }
  for (const [anchor, label] of Object.entries(override.labels ?? {})) {
    const binding = bindingOf(anchor);
    const field = binding?.source?.startsWith("answers.") ? fields().get(binding.source.slice(8)) : undefined;
    if (field) field.label = label;
  }
  for (const anchor of override.clear ?? []) {
    bindings = bindings.filter((binding) => binding.anchor !== anchor);
    bindings.push({ anchor, action: "clear" });
  }

  // A single box beside a label ("متزوج ☐") means "this applies": its option is the label.
  for (const field of allFields(definition)) {
    if (!["choice", "multichoice"].includes(field.type) || field.options?.length !== 1 || !/^خيار \d+$/.test(field.options[0]!)) continue;
    const old = field.options[0]!;
    const option = isWeak(field.label) ? "نعم" : field.label;
    field.options = [option];
    for (const binding of bindings) if (binding.source === `answers.${field.key}` && binding.option === old) binding.option = option;
  }
  // Options that are really another question's label (a date or text question printed on
  // the same line, e.g. "تاريخ وجوده به") are dropped; their boxes stay as in the original.
  const textLabels = new Set(
    allFields(definition)
      // Detail questions shown only for an option ("غير متوافر – ولماذا") share its name; they are not labels.
      .filter((field) => !["choice", "multichoice", "yesno", "attestation"].includes(field.type) && !isWeak(field.label) && !field.visible_if)
      .map((field) => fold(tidyLabel(field.label))),
  );
  for (const field of allFields(definition)) {
    if (!["choice", "multichoice"].includes(field.type) || !field.options?.length) continue;
    const bad = field.options.filter((option) => textLabels.has(fold(option)) || /[:：]$/.test(option));
    if (!bad.length || bad.length === field.options.length) continue;
    field.options = field.options.filter((option) => !bad.includes(option));
    bindings = bindings.filter((binding) => !(binding.source === `answers.${field.key}` && binding.option && bad.includes(binding.option)));
  }

  // Questions still named weakly get their section's name so the investigator knows the context.
  for (const section of definition.sections) {
    let index = 0;
    for (const field of section.fields) {
      if (field.type !== "attestation" && isWeak(field.label)) field.label = `${section.title} — بيان ${++index}`;
    }
  }
  // Duplicate labels inside a section are numbered.
  for (const section of definition.sections) {
    const seen = new Map<string, number>();
    for (const field of section.fields) {
      const count = (seen.get(field.label) ?? 0) + 1;
      seen.set(field.label, count);
      if (count > 1) field.label = `${field.label} (${count})`;
    }
  }
  // Questions bound nowhere and holding nothing are dropped (photos and statements stay).
  const placed = new Set(bindings.map((binding) => binding.source?.slice(8)));
  for (const section of definition.sections) {
    section.fields = section.fields.filter(
      (field) => placed.has(field.key) || ["photos", "signature", "attestation", "table"].includes(field.type) || field.prefill,
    );
  }
  definition.sections = definition.sections.filter((section) => section.fields.length);
  // A condition on a question that no longer exists is dropped: the detail is always shown.
  const keys = new Set(allFields(definition).map((field) => field.key));
  const refersToKnown = (expr: unknown): boolean => {
    const item = expr as Record<string, unknown>;
    if (Array.isArray(item.all)) return item.all.every(refersToKnown);
    if (Array.isArray(item.any)) return item.any.every(refersToKnown);
    if (item.not) return refersToKnown(item.not);
    return keys.has(String(item.field ?? "").split(".")[0]!);
  };
  for (const field of allFields(definition)) {
    if (field.visible_if && !refersToKnown(field.visible_if)) delete field.visible_if;
    if (field.required_if && !refersToKnown(field.required_if)) delete field.required_if;
  }
  // Identity of the person investigated is always asked for.
  for (const field of allFields(definition)) if (field.key === "subject_name") field.required = true;
  const parsed = parseDefinition(definition);

  // ── 3. Verify what the warnings describe is gone, then record them as resolved ──
  const warnings = (row.warnings as InventoryWarning[]) ?? [];
  const acknowledged = new Set((row.acknowledged as string[]) ?? []);
  const imageSlots = slots.filter((slot) => slot.kind === "image" && slot.image?.md5);
  const personalImages = imageSlots.filter((slot) => slot.image!.role === "unknown");
  const personalCleared = personalImages.every((slot) => {
    const binding = bindingOf(slot.anchor);
    return binding?.action === "clear" || (binding?.action === "image" && binding.source !== undefined);
  });
  const sampleResolved = slots.filter((slot) => slot.sample).every((slot) => bindingOf(slot.anchor));
  const decisions: string[] = [];
  for (const warning of warnings) {
    const id = `${warning.code}:${warning.message}`;
    if (PERSONAL.has(warning.code)) {
      if (personalCleared) acknowledged.add(id);
      else decisions.push(`صورة من تقرير سابق لم تُحذف: ${warning.message}`);
    } else if (DATA_WARNINGS.has(warning.code)) {
      if (warning.code === "sample_text" || warning.code === "sample_date") {
        if (sampleResolved) acknowledged.add(id);
        else decisions.push(warning.message);
      } else acknowledged.add(id);
    } else if (warning.code === "client_uncertain") {
      decisions.push(
        `العميل غير مذكور داخل الملف (لا اسم ولا شعار)؛ نُسب إلى «${row.client_name}» من اسم المجلد فقط — أكّد العميل`,
      );
    } else if (warning.code === "type_uncertain" && typeOf(path.split("/")[1] ?? "") === inventory.investigation_type.code && inventory.investigation_type.code === row.investigation_type) {
      // The folder and the document title agree; only the file name disagreed.
      acknowledged.add(id);
    } else if (warning.code === "type_uncertain") {
      decisions.push(`${warning.message} (مُعتمد حاليًا: ${row.type_name ?? row.investigation_type})`);
    } else if (warning.code === "folder_mismatch") {
      decisions.push(warning.message);
    } else if (warning.severity !== "block") acknowledged.add(id);
  }
  for (const note of override.notes ?? []) decisions.push(note);

  // Safety: checkboxes the scanner mapped must not get lost here (a couple may be labels).
  const checksBefore = (row.bindings as Binding[]).filter((binding) => binding.action === "check").length;
  const newSquares = new Set(unlabeledBoxes.map((slot) => slot.anchor));
  const checksAfter = bindings.filter((binding) => binding.action === "check" && !newSquares.has(binding.anchor)).length;
  if (checksBefore - checksAfter > 2) {
    decisions.push(`فُقد ربط ${checksBefore - checksAfter} مربع اختيار أثناء الإكمال الآلي؛ راجع الربط المرئي`);
  }
  // Safety: the filled layout must still be a valid Word document.
  try {
    const filled = renderTemplate(layout, bindings, {
      definition: parsed,
      answers: sampleAnswers(parsed),
      caseValues: { subject_name: "تجربة", report_date: "01/01/2026" },
      images: {},
      evidence: { photos: {}, locations: [] },
    }).docx;
    DocxPackage.open(filled).xml("word/document.xml");
  } catch (error) {
    decisions.push(`تعذّر ملء التصميم: ${(error as Error).message.slice(0, 160)}`);
  }
  const placedKeys = new Set(bindings.map((binding) => binding.source?.slice(8)));
  const unplaced = allFields(parsed)
    .filter((field) => !placedKeys.has(field.key) && !["photos", "signature"].includes(field.type))
    .map((field) => field.label);
  const boundAnchors = new Set(bindings.map((binding) => binding.anchor));
  const unboundPlaces = slots.filter(
    (slot) => !boundAnchors.has(slot.anchor) && slot.kind !== "image" && !rowAnchors.has(slot.anchor),
  ).length;

  const updated = { ...row, definition: parsed, bindings, acknowledged: [...acknowledged] };
  const check = await checkVersion(updated);
  const blocking = check.errors.filter((error) => !/لم يُعرف العميل|عنوان المستند يقول/.test(error.message));
  for (const error of blocking) decisions.push(error.message);

  const outcome: Outcome = {
    path,
    client: String(row.client_name),
    type: String(row.type_name ?? row.investigation_type),
    fields: allFields(parsed).length,
    status: decisions.length ? "needs_decision" : "in_review",
    decisions,
    notes,
    unplaced,
    unbound_places: unboundPlaces,
  };
  if (DRY) {
    if (process.env.VERBOSE) {
      for (const field of allFields(parsed)) {
        const where = bindings.filter((binding) => binding.source === `answers.${field.key}`).map((binding) => binding.anchor + (binding.option ? `=${binding.option}` : ""));
        console.log(`   ${field.type.padEnd(11)} ${field.label} ${field.options ? `[${field.options.join("|")}]` : ""} @ ${where.join(",")}`);
      }
      for (const binding of bindings.filter((item) => item.source?.startsWith("case."))) console.log(`   case ${binding.source} @ ${binding.anchor}`);
    }
    return outcome;
  }

  const note = decisions.length
    ? `أُكمل الربط آليًا من الملف الأصلي. قرارات مطلوبة من الإدارة العليا: ${decisions.join(" • ")}`
    : "أُكمل الربط آليًا من الملف الأصلي وتحقق من حذف بيانات التقارير السابقة. جاهز للاعتماد.";
  await query(
    `UPDATE template_versions SET definition = $2::text::jsonb, bindings = $3::text::jsonb, acknowledged = $4::text::jsonb,
       change_note = $5, updated_at = now() WHERE version_id = $1 AND status = 'draft'`,
    [row.version_id, JSON.stringify(parsed), JSON.stringify(bindings), JSON.stringify([...acknowledged]), note],
  );
  await logTemplateEvent({
    type: "version.configured",
    template_id: row.template_id as string,
    version_id: row.version_id as string,
    actor_id: "system",
    note,
    metadata: { fields: outcome.fields, decisions: decisions.length },
  });
  if (!decisions.length) {
    const hash = await contentHash(parsed, bindings, (row.layout_sha256 as string) ?? null);
    await query("UPDATE template_versions SET content_hash = $2 WHERE version_id = $1 AND status = 'draft'", [row.version_id, hash]);
    await query(
      `UPDATE template_versions SET status = 'in_review', submitted_by = 'system', submitted_at = now(), updated_at = now()
       WHERE version_id = $1 AND status = 'draft'`,
      [row.version_id],
    );
    await logTemplateEvent({
      type: "version.submitted",
      template_id: row.template_id as string,
      version_id: row.version_id as string,
      actor_id: "system",
      note: "أُرسل للمراجعة بعد اكتمال الربط",
      metadata: { content_hash: hash },
    });
  }
  return outcome;
}

await connectDatabase();
try {
  const rows = await query(
    `SELECT v.*, t.title, t.client_id, t.investigation_type, c.name AS client_name, it.name AS type_name,
            f.source_path, f.inventory
     FROM template_versions v JOIN form_templates t ON t.template_id = v.template_id
     JOIN form_clients c ON c.client_id = t.client_id
     LEFT JOIN investigation_types it ON it.code = t.investigation_type
     JOIN template_files f ON f.file_id = v.source_file_id
     WHERE v.layout_mode = 'docx' AND v.status = 'draft' AND v.created_by = 'system'
       AND NOT EXISTS (SELECT 1 FROM template_events e WHERE e.version_id = v.version_id
                       AND (e.type = 'version.edited' OR (e.actor_id IS NOT NULL AND e.actor_id <> 'system')))
     ORDER BY f.source_path`,
  );
  const outcomes: Outcome[] = [];
  for (const row of rows) {
    if (FILTER && !String(row.source_path).includes(FILTER)) continue;
    try {
      const outcome = await configure(row);
      outcomes.push(outcome);
      console.log(`${outcome.status === "in_review" ? "READY " : "DECIDE"} ${outcome.path} | ${outcome.fields} fields${outcome.decisions.length ? ` | ${outcome.decisions.join(" • ")}` : ""}`);
    } catch (error) {
      console.log(`FAILED ${row.source_path}: ${(error as Error).message}`);
      outcomes.push({ path: String(row.source_path), client: String(row.client_name), type: String(row.type_name), fields: 0, status: "skipped", decisions: [(error as Error).message], notes: [], unplaced: [], unbound_places: 0 });
    }
  }
  writeFileSync(new URL("../Seeds/template-configuration-report.json", import.meta.url), JSON.stringify(outcomes, null, 2));
  console.log(`\n${outcomes.length} processed: ${outcomes.filter((o) => o.status === "in_review").length} ready for approval, ${outcomes.filter((o) => o.status === "needs_decision").length} need a decision, ${outcomes.filter((o) => o.status === "skipped").length} failed`);
} finally {
  await database.end();
}
