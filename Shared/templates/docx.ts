import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/** WordprocessingML namespaces used while reading and filling templates. */
export const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
  ct: "http://schemas.openxmlformats.org/package/2006/content-types",
  v: "urn:schemas-microsoft-com:vml",
  wps: "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
} as const;

const IMAGE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

export type El = Element;

export function isEl(node: Node | null | undefined): node is El {
  return Boolean(node) && node!.nodeType === 1;
}

/** Local name of an element: `w:p` → `p`. */
export const local = (el: El) => el.localName ?? el.nodeName.replace(/^.*:/, "");
export const isW = (el: Node | null | undefined, name: string): el is El =>
  isEl(el) && el.namespaceURI === NS.w && local(el) === name;

export function children(el: El, name?: string, ns: string = NS.w): El[] {
  const out: El[] = [];
  for (let node = el.firstChild; node; node = node.nextSibling) {
    if (isEl(node) && (!name || (local(node) === name && node.namespaceURI === ns))) out.push(node);
  }
  return out;
}

export function child(el: El, name: string, ns: string = NS.w): El | undefined {
  return children(el, name, ns)[0];
}

export function descendants(el: El, name: string, ns: string = NS.w): El[] {
  return Array.from(el.getElementsByTagNameNS(ns, name)) as El[];
}

export function ancestor(el: Node, name: string, ns: string = NS.w): El | undefined {
  for (let node = el.parentNode; node; node = node.parentNode) {
    if (isEl(node) && local(node) === name && node.namespaceURI === ns) return node;
  }
  return undefined;
}

export const attr = (el: El | undefined, name: string, ns: string = NS.w) =>
  el ? (el.getAttributeNS(ns, name) ?? el.getAttribute(`w:${name}`) ?? null) : null;

/** Visible text of a run, paragraph or cell, with tabs and breaks as spaces. */
export function textOf(el: El): string {
  let out = "";
  const walk = (node: Node) => {
    if (!isEl(node)) return;
    // Text boxes are read separately, as their own blocks; fallbacks duplicate them.
    if (node.namespaceURI === NS.mc && local(node) === "Fallback") return;
    if (node.namespaceURI === NS.w && local(node) === "txbxContent") return;
    if (node.namespaceURI === NS.w) {
      const name = local(node);
      if (name === "t") {
        out += node.textContent ?? "";
        return;
      }
      if (name === "tab" || name === "br" || name === "cr") {
        out += " ";
        return;
      }
      if (name === "sym") {
        out += symText(node);
        return;
      }
      if (name === "delText" || name === "instrText") return;
    }
    for (let next = node.firstChild; next; next = next.nextSibling) walk(next);
  };
  walk(el);
  return out;
}

/** Wingdings box symbols read as an empty box so checkbox detection sees them. */
export function symText(sym: El): string {
  const font = (attr(sym, "font") ?? "").toLowerCase();
  const char = (attr(sym, "char") ?? "").toUpperCase().replace(/^F0/, "");
  if (font.startsWith("wingdings") && ["A2", "A3", "6F", "71", "A8", "70"].includes(char)) return "☐";
  if (font.startsWith("wingdings") && ["FE", "FD", "78", "54", "52", "53"].includes(char)) return "☒";
  return "";
}

export function wEl(doc: Document, name: string, attrs: Record<string, string> = {}): El {
  const el = doc.createElementNS(NS.w, `w:${name}`);
  for (const [key, value] of Object.entries(attrs)) el.setAttributeNS(NS.w, `w:${key}`, value);
  return el;
}

export function insertAfter(node: Node, reference: Node): void {
  const parent = reference.parentNode!;
  if (reference.nextSibling) parent.insertBefore(node, reference.nextSibling);
  else parent.appendChild(node);
}

export function remove(node: Node | null | undefined): void {
  node?.parentNode?.removeChild(node);
}

const parser = () =>
  new DOMParser({
    // Word documents are well-formed; anything else is a broken upload.
    errorHandler: {
      warning: () => {},
      error: (message: string) => {
        throw new Error(`Invalid document XML: ${message}`);
      },
      fatalError: (message: string) => {
        throw new Error(`Invalid document XML: ${message}`);
      },
    },
  });

/** An opened .docx: its zip parts, with XML parts parsed on demand and saved back. */
export class DocxPackage {
  private readonly parsed = new Map<string, Document>();

  private constructor(private readonly files: Record<string, Uint8Array>) {}

  static open(bytes: Uint8Array): DocxPackage {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes);
    } catch {
      throw new Error("The file is not a valid Word document (.docx)");
    }
    if (!files["word/document.xml"] || !files["[Content_Types].xml"]) {
      throw new Error("The file is not a valid Word document (.docx)");
    }
    return new DocxPackage(files);
  }

  has(part: string): boolean {
    return part in this.files;
  }

  names(): string[] {
    return Object.keys(this.files);
  }

  bytes(part: string): Uint8Array | undefined {
    return this.files[part];
  }

  setBytes(part: string, bytes: Uint8Array): void {
    this.files[part] = bytes;
    this.parsed.delete(part);
  }

  xml(part: string): Document {
    let doc = this.parsed.get(part);
    if (!doc) {
      const bytes = this.files[part];
      if (!bytes) throw new Error(`Missing part ${part}`);
      doc = parser().parseFromString(strFromU8(bytes), "application/xml") as unknown as Document;
      this.parsed.set(part, doc);
    }
    return doc;
  }

  /** The body plus every header and footer, in a stable order. */
  textParts(): string[] {
    const extra = this.names()
      .filter((name) => /^word\/(header|footer)\d*\.xml$/.test(name))
      .sort();
    return ["word/document.xml", ...extra];
  }

  relsPart(part: string): string {
    const slash = part.lastIndexOf("/");
    return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
  }

  /** Target part of a relationship id, resolved against the owning part. */
  relTarget(part: string, id: string): string | null {
    const rels = this.relsPart(part);
    if (!this.has(rels)) return null;
    for (const rel of Array.from(this.xml(rels).getElementsByTagNameNS(NS.rel, "Relationship")) as El[]) {
      if (rel.getAttribute("Id") === id) {
        const target = rel.getAttribute("Target") ?? "";
        if (rel.getAttribute("TargetMode") === "External") return null;
        return target.startsWith("/") ? target.slice(1) : normalize(`${part.slice(0, part.lastIndexOf("/"))}/${target}`);
      }
    }
    return null;
  }

  /** Adds an image part related to `part` and returns its relationship id. */
  addImage(part: string, bytes: Uint8Array, extension: "png" | "jpeg" | "jpg" | "webp"): string {
    const ext = extension === "jpg" ? "jpeg" : extension;
    let index = 1;
    while (this.has(`word/media/gp-${index}.${ext}`)) index += 1;
    const name = `gp-${index}.${ext}`;
    this.files[`word/media/${name}`] = bytes;
    this.ensureDefault(ext, ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg");

    const relsPart = this.relsPart(part);
    if (!this.has(relsPart)) {
      this.files[relsPart] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS.rel}"></Relationships>`,
      );
      this.parsed.delete(relsPart);
    }
    const rels = this.xml(relsPart);
    const used = new Set(
      (Array.from(rels.getElementsByTagNameNS(NS.rel, "Relationship")) as El[]).map((rel) => rel.getAttribute("Id")),
    );
    let n = 1;
    while (used.has(`rIdGp${n}`)) n += 1;
    const rel = rels.createElementNS(NS.rel, "Relationship");
    rel.setAttribute("Id", `rIdGp${n}`);
    rel.setAttribute("Type", IMAGE_REL);
    rel.setAttribute("Target", `${part.startsWith("word/") ? "" : "word/"}media/${name}`);
    rels.documentElement!.appendChild(rel);
    return `rIdGp${n}`;
  }

  private ensureDefault(extension: string, contentType: string): void {
    const types = this.xml("[Content_Types].xml");
    const defaults = Array.from(types.getElementsByTagNameNS(NS.ct, "Default")) as El[];
    if (defaults.some((item) => item.getAttribute("Extension")?.toLowerCase() === extension)) return;
    const item = types.createElementNS(NS.ct, "Default");
    item.setAttribute("Extension", extension);
    item.setAttribute("ContentType", contentType);
    types.documentElement!.insertBefore(item, types.documentElement!.firstChild);
  }

  save(): Uint8Array {
    const serializer = new XMLSerializer();
    const out: Record<string, Uint8Array> = { ...this.files };
    for (const [part, doc] of this.parsed) out[part] = strToU8(serializer.serializeToString(doc as never));
    // [Content_Types].xml first, as Word and LibreOffice expect.
    const ordered: Record<string, [Uint8Array, { level: 6 }]> = {};
    for (const name of ["[Content_Types].xml", ...Object.keys(out).filter((key) => key !== "[Content_Types].xml")]) {
      ordered[name] = [out[name]!, { level: 6 }];
    }
    return zipSync(ordered);
  }
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const piece of path.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece && piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}

/** Detects JPEG/PNG/WebP from bytes; anything else is rejected. */
export function imageKind(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "webp";
  return null;
}

/** Pixel size of a JPEG or PNG, so pictures keep their proportions in the report. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const kind = imageKind(bytes);
  if (kind === "png" && bytes.length > 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (kind === "jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!, width: (bytes[offset + 7]! << 8) | bytes[offset + 8]! };
      }
      offset += 2 + length;
    }
  }
  if (kind === "webp" && bytes.length > 30) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === "VP8X") return { width: 1 + (view.getUint32(24, true) & 0xffffff), height: 1 + (view.getUint32(27, true) & 0xffffff) };
    if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  return null;
}

export async function sha256(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function md5(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("md5").update(bytes).digest("hex");
}
