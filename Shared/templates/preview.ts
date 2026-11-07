/**
 * An HTML picture of a prepared template for the visual field mapper. It keeps the
 * reading order, tables, merged cells, checkboxes, text boxes and pictures, and wraps
 * every bookmarked slot in a clickable element. The exact layout is the PDF preview;
 * this view exists so Head Office can point at a place and say what goes there.
 */
import { attr, child, children, descendants, DocxPackage, type El, local, NS, symText, textOf } from "./docx.ts";
import { lengthOf, paragraphsOf } from "./edit.ts";

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const EMU_PX = 9525;

export class LayoutHtml {
  private openSlots: string[] = [];

  /** Each paragraph's position in its part, as the server counts it when a point is dropped. */
  private readonly index = new Map<El, string>();

  constructor(private readonly pkg: DocxPackage) {
    for (const part of pkg.textParts()) {
      paragraphsOf(pkg, part).forEach((paragraph, position) => this.index.set(paragraph, `${part}|${position}`));
    }
  }

  render(): string {
    const out: string[] = [];
    for (const part of this.pkg.textParts().filter((name) => name.includes("header"))) {
      const html = this.blocks(this.pkg.xml(part).documentElement as El, part);
      if (html.trim()) out.push(`<div class="doc-header" data-part="${part}">${html}</div>`);
    }
    const body = child(this.pkg.xml("word/document.xml").documentElement as El, "body");
    if (body) out.push(`<div class="doc-body">${this.blocks(body, "word/document.xml")}</div>`);
    for (const part of this.pkg.textParts().filter((name) => name.includes("footer"))) {
      const html = this.blocks(this.pkg.xml(part).documentElement as El, part);
      if (html.trim()) out.push(`<div class="doc-footer" data-part="${part}">${html}</div>`);
    }
    return out.join("");
  }

  private blocks(root: El, part: string): string {
    let html = "";
    for (const block of children(root)) {
      const name = local(block);
      if (name === "p") html += this.paragraph(block, part);
      else if (name === "tbl") html += this.table(block, part);
      else if (name === "sdt") {
        const content = child(block, "sdtContent");
        if (content) html += this.blocks(content, part);
      }
    }
    return html;
  }

  private paragraph(paragraph: El, part: string): string {
    const pPr = child(paragraph, "pPr");
    const jc = attr(pPr ? child(pPr, "jc") : undefined, "val");
    const align = jc === "center" ? "center" : jc === "left" || jc === "start" ? "left" : jc === "both" ? "justify" : "right";
    const pageBreak = pPr && child(pPr, "pageBreakBefore") ? '<hr class="page-break">' : "";
    const inner = this.inline(paragraph, part, true);
    const boxes = descendants(paragraph, "txbxContent")
      .filter((box) => !box.parentNode || !this.inFallback(box))
      .map((box) => `<div class="doc-textbox">${this.blocks(box, part) || "&nbsp;"}</div>`)
      .join("");
    const where = this.index.get(paragraph);
    const target = where ? ` data-p="${where}" data-len="${textOf(paragraph).length}"` : "";
    return `${pageBreak}<p style="text-align:${align}"${target}>${inner || "&#8203;"}</p>${boxes}`;
  }

  private inFallback(node: Node): boolean {
    for (let parent = node.parentNode; parent; parent = parent.parentNode) {
      if (parent.nodeType === 1 && (parent as El).namespaceURI === NS.mc && local(parent as El) === "Fallback") return true;
    }
    return false;
  }

  private inline(container: El, part: string, top = false): string {
    let html = "";
    let offset = 0;
    for (const node of children(container)) {
      const name = local(node);
      // Top-level pieces carry their text offset so a drop lands at the right character.
      if (top && ["r", "sdt", "hyperlink", "ins", "smartTag", "customXml", "fldSimple"].includes(name)) {
        const start = offset;
        offset += lengthOf(node);
        const inner = name === "r" ? this.run(node, part) : this.inline(name === "sdt" ? node : node, part);
        if (name === "sdt") {
          html += `<span data-o="${start}">${this.sdt(node, part)}</span>`;
        } else html += inner ? `<span data-o="${start}">${inner}</span>` : "";
        continue;
      }
      if (name === "bookmarkStart") {
        const slot = attr(node, "name") ?? "";
        if (!slot.startsWith("gp_")) continue;
        // A point bookmark (start right before its end) shows as a small target.
        const next = node.nextSibling as El | null;
        const point = next && next.nodeType === 1 && local(next) === "bookmarkEnd" && attr(next, "id") === attr(node, "id");
        if (point) html += `<span class="slot slot-point" data-anchor="${slot}" tabindex="0" role="button">◂</span>`;
        else {
          this.openSlots.push(attr(node, "id") ?? "");
          html += `<span class="slot" data-anchor="${slot}" tabindex="0" role="button">`;
        }
      } else if (name === "bookmarkEnd") {
        const index = this.openSlots.indexOf(attr(node, "id") ?? "");
        if (index >= 0) {
          this.openSlots.splice(index, 1);
          html += "</span>";
        }
      } else if (name === "r") html += this.run(node, part);
      else if (name === "sdt") html += this.sdt(node, part);
      else if (["hyperlink", "ins", "smartTag", "customXml", "fldSimple"].includes(name)) html += this.inline(node, part);
    }
    return html;
  }

  private sdt(node: El, part: string): string {
    if (descendants(node, "checkbox", NS.w14).length) {
      const checked = descendants(node, "checked", NS.w14)[0]?.getAttributeNS(NS.w14, "val") === "1";
      return `<span class="box">${checked ? "☒" : "☐"}</span>`;
    }
    const content = child(node, "sdtContent");
    return content ? this.inline(content, part) : "";
  }

  private run(run: El, part: string): string {
    const rPr = child(run, "rPr");
    const bold = rPr && (child(rPr, "b") || child(rPr, "bCs"));
    const underline = rPr && child(rPr, "u") && attr(child(rPr, "u"), "val") !== "none";
    const color = attr(rPr ? child(rPr, "color") : undefined, "val");
    const highlight = attr(rPr ? child(rPr, "highlight") : undefined, "val");
    let html = "";
    for (const item of children(run)) {
      const name = local(item);
      if (name === "t") html += escape(item.textContent ?? "");
      else if (name === "tab") html += "&emsp;";
      else if (name === "br") html += attr(item, "type") === "page" ? '<hr class="page-break">' : "<br>";
      else if (name === "sym") html += `<span class="box">${symText(item) || "•"}</span>`;
      else if (name === "drawing" || name === "pict" || name === "AlternateContent") html += this.drawing(item, part);
    }
    if (!html) return "";
    const style = [
      bold ? "font-weight:700" : "",
      underline ? "text-decoration:underline" : "",
      color && color !== "auto" ? `color:#${color}` : "",
      highlight && highlight !== "none" ? `background:${highlight === "yellow" ? "#fff59d" : "#e8eef7"}` : "",
    ].filter(Boolean).join(";");
    return style ? `<span style="${style}">${html}</span>` : html;
  }

  private drawing(drawing: El, part: string): string {
    if (this.inFallback(drawing)) return "";
    const blip = descendants(drawing, "blip", NS.a)[0] ?? descendants(drawing, "imagedata", NS.v)[0];
    const id = blip ? blip.getAttributeNS(NS.r, "embed") || blip.getAttributeNS(NS.r, "id") : "";
    const extent = descendants(drawing, "extent", NS.wp)[0];
    const width = Math.min(Math.round(Number(extent?.getAttribute("cx") ?? 0) / EMU_PX) || 80, 620);
    const height = Math.min(Math.round(Number(extent?.getAttribute("cy") ?? 0) / EMU_PX) || 60, 700);
    if (id) {
      const target = this.pkg.relTarget(part, id);
      const bytes = target ? this.pkg.bytes(target) : undefined;
      if (bytes && /\.(png|jpe?g|gif|webp)$/i.test(target ?? "")) {
        const type = /\.png$/i.test(target!) ? "png" : /\.gif$/i.test(target!) ? "gif" : /\.webp$/i.test(target!) ? "webp" : "jpeg";
        return `<img alt="" src="data:image/${type};base64,${Buffer.from(bytes).toString("base64")}" style="width:${width}px;max-height:${height}px">`;
      }
      return `<span class="doc-image" style="width:${Math.min(width, 40)}px;height:${Math.min(height, 40)}px"></span>`;
    }
    if (descendants(drawing, "txbxContent").some((box) => textOf(box).trim())) return "";
    if (width < 45 && height < 45) return '<span class="box">☐</span>';
    return "";
  }

  private table(table: El, part: string): string {
    const rows = children(table, "tr");
    // Row spans: a cell that restarts a vertical merge spans the continuing cells below.
    const grid = rows.map((row) => {
      let column = 0;
      return children(row, "tc").map((cell) => {
        const tcPr = child(cell, "tcPr");
        const span = Number(attr(tcPr ? child(tcPr, "gridSpan") : undefined, "val") ?? 1) || 1;
        const merge = tcPr ? child(tcPr, "vMerge") : undefined;
        const state = merge ? (attr(merge, "val") === "restart" ? "restart" : "continue") : "none";
        const entry = { cell, column, span, state, rowspan: 1 };
        column += span;
        return entry;
      });
    });
    grid.forEach((row, r) => {
      for (const entry of row) {
        if (entry.state !== "restart") continue;
        for (let below = r + 1; below < grid.length; below += 1) {
          const match = grid[below]!.find((item) => item.column === entry.column && item.state === "continue");
          if (!match) break;
          entry.rowspan += 1;
        }
      }
    });
    let html = '<table class="doc-table">';
    grid.forEach((row) => {
      html += "<tr>";
      for (const entry of row) {
        if (entry.state === "continue") continue;
        const tcPr = child(entry.cell, "tcPr");
        const fill = attr(tcPr ? child(tcPr, "shd") : undefined, "fill");
        const background = fill && fill !== "auto" && fill !== "FFFFFF" ? ` style="background:#${fill}"` : "";
        html += `<td colspan="${entry.span}" rowspan="${entry.rowspan}"${background}>${this.blocks(entry.cell, part)}</td>`;
      }
      html += "</tr>";
    });
    return `${html}</table>`;
  }
}

export function layoutHtml(bytes: Uint8Array): string {
  return new LayoutHtml(DocxPackage.open(bytes)).render();
}
