import { join } from "node:path";
import { putStoredFile } from "../IdentityAcess_Services/Utils/files.ts";

/** Saves a generated report file next to the case's photos and returns its stored path. */
export async function storeReportFile(investigationId: string, name: string, bytes: Uint8Array): Promise<string> {
  const relative = join("investigations", investigationId.replace(/[^a-zA-Z0-9_-]/g, ""), name);
  return putStoredFile(relative, bytes);
}
