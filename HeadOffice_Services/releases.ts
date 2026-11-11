import { query } from "../IdentityAcess_Services/Config/db.ts";
import { withAuth, type AuthContext } from "../IdentityAcess_Services/MIddlewares/auth.middleware.ts";
import { recordAudit } from "../IdentityAcess_Services/Services/audit.service.ts";
import { PERMISSIONS } from "../IdentityAcess_Services/Services/rbac.service.ts";
import { getStoredFile, putStoredFile, removeStoredFile } from "../IdentityAcess_Services/Utils/files.ts";
import { ApiError, created, ok, readJson, type RequestContext } from "../IdentityAcess_Services/Utils/http.ts";
import type { Router } from "../IdentityAcess_Services/Utils/router.ts";
import { logger } from "../IdentityAcess_Services/Utils/logger.ts";
import { ApkError, readApkVersion } from "../Shared/apk.ts";
import { optionalText } from "../Shared/service.ts";

/**
 * Mobile app updates. Head office uploads each new APK; its version code is read from the
 * APK itself (the number Android compares), never typed. The app asks
 * `/app/version` on start, and when a higher version exists it downloads the APK and hands
 * it to Android's installer, which installs it over the current app (same signing key).
 */

const MAX_APK_BYTES = 200 * 1024 * 1024;
// bigint columns come back as text from PostgreSQL; send them as numbers.
const COLUMNS = `release_id, platform, version_name, version_code::float8 AS version_code, notes, mandatory,
  size_bytes::float8 AS size_bytes, sha256, active, created_at,
  (SELECT full_name FROM users WHERE user_id = r.created_by) AS created_by_name`;

const downloadUrl = (id: string) => `/api/v1/app/releases/${id}/apk`;

/**
 * Releases uploaded before the version was read from the APK may carry a typed code that
 * does not match the APK (so phones never see them as newer). Each one is checked once
 * against its file and corrected; a duplicate of a newer release is switched off.
 */
let checking: Promise<void> | null = null;
function checkReleaseCodes(): Promise<void> {
  checking ??= (async () => {
    const rows = await query("SELECT release_id, path, version_code::float8 AS version_code FROM app_releases WHERE NOT code_checked");
    for (const row of rows) {
      try {
        const real = readApkVersion(await getStoredFile(row.path as string)).versionCode;
        if (real !== Number(row.version_code)) {
          const [taken] = await query("SELECT 1 FROM app_releases WHERE platform = 'android' AND version_code = $1 AND release_id <> $2", [real, row.release_id]);
          if (taken) await query("UPDATE app_releases SET active = false, code_checked = true WHERE release_id = $1", [row.release_id]);
          else await query("UPDATE app_releases SET version_code = $2, code_checked = true WHERE release_id = $1", [row.release_id, real]);
          logger.info("app_release.code_corrected", { release_id: row.release_id, typed: row.version_code, real, duplicate: Boolean(taken) });
        } else {
          await query("UPDATE app_releases SET code_checked = true WHERE release_id = $1", [row.release_id]);
        }
      } catch (error) {
        logger.warn("app_release.code_check_failed", { release_id: row.release_id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  })().catch((error) => {
    checking = null; // Try again on the next request.
    logger.warn("app_release.code_check_failed", { error: error instanceof Error ? error.message : String(error) });
  });
  return checking;
}

function withManage(handler: (context: RequestContext, auth: AuthContext) => Promise<Response>) {
  return withAuth((context, auth) => {
    if (!auth.access.permissions.includes(PERMISSIONS.HEADOFFICE_MANAGE)) throw ApiError.forbidden("Head office access only");
    return handler(context, auth);
  });
}

export function registerReleaseRoutes(router: Router): void {
  // Public: the app checks before anyone signs in, so even an old app can update itself.
  router.get("/app/version", async (context) => {
    const platform = context.url.searchParams.get("platform") === "ios" ? "ios" : "android";
    const current = Number(context.url.searchParams.get("code") ?? 0) || 0;
    await checkReleaseCodes();
    const [latest] = await query(
      `SELECT ${COLUMNS} FROM app_releases r WHERE platform = $1 AND active ORDER BY version_code DESC LIMIT 1`,
      [platform],
    );
    // An update is mandatory if any newer release was marked mandatory.
    const [forced] = await query(
      "SELECT 1 FROM app_releases WHERE platform = $1 AND active AND mandatory AND version_code > $2 LIMIT 1",
      [platform, current],
    );
    return ok({
      update: Boolean(latest && Number(latest.version_code) > current),
      mandatory: Boolean(forced),
      latest: latest ? { ...latest, download_url: downloadUrl(latest.release_id as string) } : null,
    });
  });

  router.get("/app/releases/:id/apk", async (context) => {
    const [row] = await query("SELECT * FROM app_releases WHERE release_id = $1 AND active", [context.params.id]);
    if (!row) throw ApiError.notFound("This update is no longer available");
    const bytes = await getStoredFile(row.path as string);
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="golden-pay-${row.version_name}-${row.version_code}.apk"`,
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  });

  router.get(
    "/headoffice/app-releases",
    withManage(async () => {
      await checkReleaseCodes();
      return ok({ releases: await query(`SELECT ${COLUMNS} FROM app_releases r ORDER BY version_code DESC LIMIT 100`) });
    }),
  );

  router.post(
    "/headoffice/app-releases",
    withManage(async (context, auth) => {
      // APKs are far larger than the ID photos the shared form reader is sized for.
      const declared = Number(context.req.headers.get("content-length") ?? 0);
      if (declared > MAX_APK_BYTES + 1024 * 1024) throw ApiError.payloadTooLarge("The APK is larger than 200 MB");
      const form = (await context.req.formData().catch(() => {
        throw ApiError.badRequest("Malformed multipart/form-data body");
      })) as unknown as FormData;
      const file = form.get("apk");
      if (!(file instanceof File) || !file.size) throw ApiError.badRequest("Choose the APK file", { field: "apk" });
      if (file.size > MAX_APK_BYTES) throw ApiError.badRequest("The APK is larger than 200 MB", { field: "apk" });
      const bytes = new Uint8Array(await file.arrayBuffer());
      // An APK is a ZIP archive: it starts with "PK\x03\x04".
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
        throw ApiError.badRequest("This file is not an Android APK", { field: "apk" });
      }
      // The version Android compares comes from the APK itself, so it can never be mistyped.
      let apk;
      try {
        apk = readApkVersion(bytes);
      } catch (error) {
        if (error instanceof ApkError) throw ApiError.badRequest(error.message, { field: "apk" });
        throw error;
      }
      const versionCode = apk.versionCode;
      // The name is only a label for people: what was written, else the APK's own.
      const typedName = optionalText(form.get("version_name"), 40);
      if (typedName && !/^\d+(\.\d+){0,3}$/.test(typedName)) {
        throw ApiError.badRequest("Write the version like 1.2.0, or leave it empty", { field: "version_name" });
      }
      const versionName = typedName || apk.versionName || "1.0.0";
      await checkReleaseCodes();
      const [highest] = await query("SELECT max(version_code)::bigint AS code FROM app_releases WHERE platform = 'android' AND active");
      if (highest?.code && versionCode <= Number(highest.code)) {
        throw new ApiError(
          409,
          "VERSION_NOT_NEWER",
          `This APK (version code ${versionCode}) is not newer than the last upload (${Number(highest.code)}). Build a new APK with build-apk.sh and upload that one.`,
          { details: { field: "apk", apk: versionCode, last: Number(highest.code) } },
        );
      }
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      const [row] = await query(
        `INSERT INTO app_releases(platform,version_name,version_code,notes,mandatory,size_bytes,sha256,path,created_by,code_checked)
         VALUES('android',$1,$2,$3,$4,$5,$6,'',$7,true) RETURNING release_id`,
        [versionName, versionCode, optionalText(form.get("notes"), 2000), form.get("mandatory") === "true", bytes.byteLength, sha256, auth.user.user_id],
      );
      const id = row!.release_id as string;
      try {
        const path = await putStoredFile(`app-releases/${id}/golden-pay-${versionName}-${versionCode}.apk`, bytes, "application/vnd.android.package-archive");
        await query("UPDATE app_releases SET path = $2 WHERE release_id = $1", [id, path]);
      } catch (error) {
        await query("DELETE FROM app_releases WHERE release_id = $1", [id]);
        throw error;
      }
      await recordAudit({
        event: "headoffice.app_release.published",
        actorId: auth.user.user_id,
        success: true,
        context,
        metadata: { version_name: versionName, version_code: versionCode, size: bytes.byteLength },
      });
      return created({ release_id: id, version_code: versionCode, version_name: versionName, package_name: apk.packageName });
    }),
  );

  router.patch(
    "/headoffice/app-releases/:id",
    withManage(async (context, auth) => {
      const body = await readJson(context.req);
      const rows = await query(
        `UPDATE app_releases SET
           active = COALESCE($2, active), mandatory = COALESCE($3, mandatory), notes = COALESCE($4, notes)
         WHERE release_id = $1 RETURNING release_id`,
        [
          context.params.id,
          typeof body.active === "boolean" ? body.active : null,
          typeof body.mandatory === "boolean" ? body.mandatory : null,
          typeof body.notes === "string" ? body.notes.slice(0, 2000) : null,
        ],
      );
      if (!rows.length) throw ApiError.notFound("Release not found");
      await recordAudit({ event: "headoffice.app_release.changed", actorId: auth.user.user_id, success: true, context, metadata: { id: context.params.id, ...body } });
      return ok({ saved: true });
    }),
  );

  router.delete(
    "/headoffice/app-releases/:id",
    withManage(async (context, auth) => {
      const [row] = await query("DELETE FROM app_releases WHERE release_id = $1 RETURNING path, version_code", [context.params.id]);
      if (!row) throw ApiError.notFound("Release not found");
      if (row.path) await removeStoredFile(row.path as string).catch(() => {});
      await recordAudit({ event: "headoffice.app_release.removed", actorId: auth.user.user_id, success: true, context, metadata: { version_code: row.version_code } });
      return ok({ deleted: true });
    }),
  );
}
