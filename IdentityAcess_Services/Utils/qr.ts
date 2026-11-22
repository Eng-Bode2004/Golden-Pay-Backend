import { deflateSync } from "node:zlib";
import QRCode from "qrcode";

const QUIET = 4; // The white margin scanners need, in modules.
const SCALE = 8;

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const head = Buffer.alloc(4);
  const tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE(Bun.hash.crc32(body));
  return Buffer.concat([head, body, tail]);
}

/**
 * A QR code as a PNG, drawn here: what it encodes never goes to an outside service.
 * Synchronous (unlike QRCode.toBuffer), because reports are filled synchronously.
 */
export function qrPng(text: string): Uint8Array {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const side = (modules.size + QUIET * 2) * SCALE;
  const rows = Buffer.alloc((side + 1) * side, 255);
  for (let y = 0; y < side; y += 1) {
    const line = y * (side + 1);
    rows[line] = 0; // PNG filter: none.
    const row = Math.floor(y / SCALE) - QUIET;
    for (let x = 0; x < side; x += 1) {
      const column = Math.floor(x / SCALE) - QUIET;
      if (row < 0 || column < 0 || row >= modules.size || column >= modules.size) continue;
      if (modules.data[row * modules.size + column]) rows[line + 1 + x] = 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8; // Bits per pixel; colour type 0 (grey).
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
