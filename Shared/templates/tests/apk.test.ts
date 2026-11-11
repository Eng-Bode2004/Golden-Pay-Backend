// The app's version is read from the uploaded APK itself, so a typed number can never make
// phones miss an update.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ApkError, readApkVersion } from "../../apk.ts";

const RELEASES = join(import.meta.dir, "..", "..", "..", "..", "releases");
const apks = existsSync(RELEASES) ? readdirSync(RELEASES).filter((name) => /^golden-pay-v[\d.]+-\d+-/.test(name)) : [];

describe("reading an APK's version", () => {
  test.if(apks.length > 0)("the version code matches the build number in the file name", () => {
    for (const name of apks) {
      const expected = Number(/^golden-pay-v[\d.]+-(\d+)-/.exec(name)![1]);
      const version = readApkVersion(new Uint8Array(readFileSync(join(RELEASES, name))));
      expect(version.versionCode).toBe(expected);
      expect(version.versionName).toMatch(/^\d+(\.\d+)*$/);
      expect(version.packageName).toBeTruthy();
    }
  });

  test("a file that is not an APK is refused", () => {
    expect(() => readApkVersion(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]))).toThrow(ApkError);
    expect(() => readApkVersion(new TextEncoder().encode("not a zip"))).toThrow(ApkError);
  });
});
