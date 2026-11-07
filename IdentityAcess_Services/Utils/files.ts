import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { S3Client } from "bun";
import { env } from "../Config/env.ts";
import { ApiError } from "./http.ts";
import { newId } from "./crypto.ts";

type ImageSide = "front" | "back";

const IMAGE_TYPES: Record<string, { extension: string; contentType: string }> = {
  "image/jpeg": { extension: "jpg", contentType: "image/jpeg" },
  "image/png": { extension: "png", contentType: "image/png" },
  "image/webp": { extension: "webp", contentType: "image/webp" },
};

function detectImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function getFormFile(form: FormData, keys: string[], label: string): File {
  for (const key of keys) {
    const value = form.get(key);
    if (value instanceof File && value.size > 0) return value;
  }
  throw ApiError.badRequest(`${label} is required`, { field: keys[0], message: `${label} is required` });
}

export function getFormString(form: FormData, keys: string[], label: string): string {
  for (const key of keys) {
    const value = form.get(key);
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  throw ApiError.badRequest(`${label} is required`, { field: keys[0], message: `${label} is required` });
}

export function getOptionalFormString(form: FormData, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = form.get(key);
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/** Converts text fields of a multipart form into a JSON-like validation body. */
export function formToJson(form: FormData): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") output[key] = value;
  }
  return output;
}

export async function saveImage(
  file: File,
  ownerId: string,
  folder: string,
  prefix: string,
  label: string,
): Promise<string> {
  if (file.size <= 0) {
    throw ApiError.badRequest("Uploaded image is empty");
  }
  if (file.size > env.maxUploadBytes) {
    throw ApiError.payloadTooLarge(
      `Each ${label} must be at most ${Math.floor(env.maxUploadBytes / (1024 * 1024))} MB`,
    );
  }

  const declaredType = file.type.toLowerCase();
  const config = IMAGE_TYPES[declaredType];
  if (!config) {
    throw ApiError.badRequest(`The ${label} must be JPEG, PNG or WebP`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detectedType = detectImageType(bytes);
  if (!detectedType || detectedType !== declaredType) {
    throw ApiError.badRequest("Uploaded file content does not match its image type");
  }

  const safeOwner = ownerId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeOwner) throw ApiError.badRequest("Invalid upload owner");

  const filename = `${prefix}-${newId()}.${config.extension}`;
  return putStoredFile(join(folder, safeOwner, filename), bytes, config.contentType);
}

export function saveNationalIdImage(
  file: File,
  ownerId: string,
  side: ImageSide,
): Promise<string> {
  return saveImage(file, ownerId, "national-ids", side, "national ID image");
}

export function saveProfileImage(file: File, ownerId: string): Promise<string> {
  return saveImage(file, ownerId, "profile-images", "portrait", "personal photo");
}

export async function deleteStoredFiles(relativePaths: Array<string | undefined>): Promise<void> {
  await Promise.all(
    relativePaths.filter((path): path is string => Boolean(path)).map(async (path) => {
      try {
        await removeStoredFile(path);
      } catch {
        // Best-effort cleanup; the original operation result is more important.
      }
    }),
  );
}

export function resolveStoredPath(relativePath: string): string {
  const absolute = resolve(env.uploadDir, relativePath);
  const root = resolve(env.uploadDir) + sep;
  if (!absolute.startsWith(root)) {
    throw ApiError.badRequest("Invalid stored file path");
  }
  return absolute;
}

export async function readStoredFile(
  relativePath: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const extension = relativePath.split(".").pop()?.toLowerCase() ?? "";
  const contentType =
    Object.values(IMAGE_TYPES).find((type) => type.extension === extension)?.contentType ??
    "application/octet-stream";

  try {
    return { bytes: Buffer.from(await getStoredFile(relativePath)), contentType };
  } catch {
    throw ApiError.notFound("Stored image not found");
  }
}

// ───────────── storage backend ─────────────
// Files live in the cloud bucket when STORAGE_BUCKET is set, otherwise under UPLOAD_DIR.
// Either way they are addressed by the same relative path that the database stores.

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  json: "application/json",
  html: "text/html; charset=utf-8",
};

let bucket: S3Client | null | undefined;
function cloud(): S3Client | null {
  if (bucket !== undefined) return bucket;
  const config = env.storage;
  bucket = config
    ? new S3Client({
        bucket: config.bucket,
        region: config.region,
        endpoint: config.endpoint,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      })
    : null;
  return bucket;
}

/** Normalises a stored path ("a\b/c.png") and refuses anything that escapes the store. */
export function storageKey(relativePath: string): string {
  const parts = relativePath.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    throw ApiError.badRequest("Invalid stored file path");
  }
  const key = parts.join("/");
  return env.storage?.folder ? `${env.storage.folder}/${key}` : key;
}

/** Retries short network drops to the bucket; a missing file fails at once. */
async function withRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (attempt >= 3 || code === "NoSuchKey" || code === "AccessDenied") throw error;
      await Bun.sleep(300 * attempt);
    }
  }
}

/** Whether files go to cloud storage (true) or the local upload folder (false). */
export function usesCloudStorage(): boolean {
  return cloud() !== null;
}

/** Saves bytes at a relative path and returns that path in its stored (forward-slash) form. */
export async function putStoredFile(relativePath: string, bytes: Uint8Array, contentType?: string): Promise<string> {
  const stored = relativePath.replaceAll("\\", "/");
  const client = cloud();
  if (client) {
    const type = contentType ?? CONTENT_TYPES[stored.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
    await withRetry(() => client.write(storageKey(stored), bytes, { type }));
  } else {
    const absolute = resolveStoredPath(stored);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
  return stored;
}

/** Reads a stored file; throws when it does not exist. */
export async function getStoredFile(relativePath: string): Promise<Uint8Array> {
  const client = cloud();
  if (client) return new Uint8Array(await withRetry(() => client.file(storageKey(relativePath)).arrayBuffer()));
  return new Uint8Array(await readFile(resolveStoredPath(relativePath)));
}

export async function removeStoredFile(relativePath: string): Promise<void> {
  const client = cloud();
  if (client) await withRetry(() => client.delete(storageKey(relativePath)));
  else await rm(resolveStoredPath(relativePath), { force: true });
}

export async function ensureUploadDirectory(): Promise<void> {
  if (cloud()) return;
  await mkdir(join(env.uploadDir, "national-ids"), { recursive: true });
  await mkdir(join(env.uploadDir, "profile-images"), { recursive: true });
}

export { dirname };
