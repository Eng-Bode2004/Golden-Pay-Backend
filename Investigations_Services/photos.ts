/**
 * Phones store many photos sideways with a note saying how to turn them (EXIF orientation).
 * Browsers follow the note; Word does not, so for client layouts the pixels are turned first.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromePath } from "./pdf.ts";

/** The EXIF orientation of a JPEG: 1 is upright, also when there is none. */
export function orientationOf(bytes: Uint8Array): number {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff; ) {
    if (bytes[at + 1] === 0xda) break; // The picture itself starts: no more notes.
    const end = at + 2 + view.getUint16(at + 2);
    if (bytes[at + 1] === 0xe1 && end <= bytes.length && at + 18 <= end && view.getUint32(at + 4) === 0x45786966) {
      const tiff = at + 10;
      const little = view.getUint16(tiff) === 0x4949;
      const directory = tiff + view.getUint32(tiff + 4, little);
      if (directory + 2 > end) return 1;
      const last = Math.min(end, directory + 2 + view.getUint16(directory, little) * 12);
      for (let entry = directory + 2; entry + 12 <= last; entry += 12) {
        if (view.getUint16(entry, little) !== 0x0112) continue;
        const value = view.getUint16(entry + 8, little);
        return value >= 1 && value <= 8 ? value : 1;
      }
    }
    at = end;
  }
  return 1;
}

/** The same photo with upright pixels. If that fails the original is printed: no picture is lost. */
export async function uprightPhoto(bytes: Uint8Array): Promise<Uint8Array> {
  if (orientationOf(bytes) === 1) return bytes;
  const dir = join(tmpdir(), `gp-photo-${crypto.randomUUID()}`);
  try {
    await mkdir(dir, { recursive: true });
    const page = join(dir, "photo.html");
    await writeFile(
      page,
      `<!doctype html><img id="photo" src="data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}"><pre id="out"></pre><script>
        addEventListener("load", () => {
          const image = document.getElementById("photo");
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext("2d").drawImage(image, 0, 0);
          document.getElementById("out").textContent = canvas.toDataURL("image/jpeg", 0.9);
          image.remove();
        });
      </script>`,
    );
    const chrome = Bun.spawn(
      [
        chromePath(),
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--no-first-run",
        `--user-data-dir=${join(dir, "profile")}`,
        "--dump-dom",
        `file:///${page.replace(/\\/g, "/")}`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const timeout = setTimeout(() => chrome.kill(), 30_000);
    const dom = await new Response(chrome.stdout).text();
    await chrome.exited;
    clearTimeout(timeout);
    const turned = /<pre id="out">data:image\/jpeg;base64,([A-Za-z0-9+/=]+)<\/pre>/.exec(dom)?.[1];
    if (turned) return new Uint8Array(Buffer.from(turned, "base64"));
    console.error("investigation.photo_rotate_failed", "no picture came back");
  } catch (error) {
    console.error("investigation.photo_rotate_failed", error instanceof Error ? error.message : String(error));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
  return bytes;
}
