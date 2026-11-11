/**
 * Reads an APK's own version (versionCode, versionName) and package name from its
 * AndroidManifest.xml, which Android stores in a compact binary XML format. Head office
 * then never has to type a version number, and the app's update check always compares the
 * numbers Android itself uses.
 */
import { unzipSync } from "fflate";

export interface ApkVersion {
  versionCode: number;
  versionName: string | null;
  packageName: string | null;
}

// Android attribute resource ids (android:versionCode, android:versionName).
const VERSION_CODE_ID = 0x0101021b;
const VERSION_NAME_ID = 0x0101021c;

const CHUNK_STRING_POOL = 0x0001;
const CHUNK_RESOURCE_MAP = 0x0180;
const CHUNK_START_ELEMENT = 0x0102;
const NO_STRING = 0xffffffff;

export class ApkError extends Error {}

export function readApkVersion(apk: Uint8Array): ApkVersion {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(apk, { filter: (file) => file.name === "AndroidManifest.xml" });
  } catch {
    throw new ApkError("This file is not a valid APK (it could not be opened)");
  }
  const manifest = files["AndroidManifest.xml"];
  if (!manifest) throw new ApkError("This APK has no AndroidManifest.xml");
  return parseManifest(manifest);
}

function parseManifest(bytes: Uint8Array): ApkVersion {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || view.getUint16(0, true) !== 0x0003) throw new ApkError("The APK's manifest is not in Android's binary format");
  let strings: string[] = [];
  let resourceIds: number[] = [];
  let offset = view.getUint16(2, true);
  while (offset + 8 <= bytes.length) {
    const type = view.getUint16(offset, true);
    const headerSize = view.getUint16(offset + 2, true);
    const size = view.getUint32(offset + 4, true);
    if (size < 8 || offset + size > bytes.length) break;
    if (type === CHUNK_STRING_POOL) strings = readStringPool(bytes, view, offset);
    else if (type === CHUNK_RESOURCE_MAP) {
      resourceIds = [];
      for (let at = offset + headerSize; at + 4 <= offset + size; at += 4) resourceIds.push(view.getUint32(at, true));
    } else if (type === CHUNK_START_ELEMENT) {
      const name = strings[view.getUint32(offset + 20, true)];
      if (name === "manifest") {
        const attributeStart = view.getUint16(offset + 24, true);
        const attributeSize = view.getUint16(offset + 26, true) || 20;
        const count = view.getUint16(offset + 28, true);
        const result: ApkVersion = { versionCode: 0, versionName: null, packageName: null };
        for (let index = 0; index < count; index += 1) {
          const at = offset + 16 + attributeStart + index * attributeSize;
          const nameIndex = view.getUint32(at + 4, true);
          const raw = view.getUint32(at + 8, true);
          const dataType = view.getUint8(at + 15);
          const data = view.getUint32(at + 16, true);
          const id = resourceIds[nameIndex];
          const label = strings[nameIndex];
          const text = raw !== NO_STRING ? (strings[raw] ?? null) : dataType === 0x03 ? (strings[data] ?? null) : null;
          if (id === VERSION_CODE_ID || label === "versionCode") result.versionCode = dataType === 0x03 ? Number(text) : data;
          else if (id === VERSION_NAME_ID || label === "versionName") result.versionName = text;
          else if (label === "package") result.packageName = text;
        }
        if (!Number.isInteger(result.versionCode) || result.versionCode < 1) throw new ApkError("The APK has no version code");
        return result;
      }
    }
    offset += size;
  }
  throw new ApkError("The APK's manifest has no version");
}

function readStringPool(bytes: Uint8Array, view: DataView, chunk: number): string[] {
  const count = view.getUint32(chunk + 8, true);
  const utf8 = (view.getUint32(chunk + 16, true) & (1 << 8)) !== 0;
  const stringsStart = view.getUint32(chunk + 20, true);
  const headerSize = view.getUint16(chunk + 2, true);
  const out: string[] = [];
  const decoder = new TextDecoder("utf-8");
  for (let index = 0; index < count; index += 1) {
    let at = chunk + stringsStart + view.getUint32(chunk + headerSize + index * 4, true);
    if (utf8) {
      // Length in characters, then in bytes; each one or two bytes long.
      at += bytes[at]! & 0x80 ? 2 : 1;
      let length = bytes[at]!;
      if (length & 0x80) {
        length = ((length & 0x7f) << 8) | bytes[at + 1]!;
        at += 2;
      } else at += 1;
      out.push(decoder.decode(bytes.subarray(at, at + length)));
    } else {
      let length = view.getUint16(at, true);
      if (length & 0x8000) {
        length = ((length & 0x7fff) << 16) | view.getUint16(at + 2, true);
        at += 4;
      } else at += 2;
      let text = "";
      for (let char = 0; char < length; char += 1) text += String.fromCharCode(view.getUint16(at + char * 2, true));
      out.push(text);
    }
  }
  return out;
}
