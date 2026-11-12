// Cached previews carry a code for the report-building sources, so a deploy that changes how
// reports are drawn does not keep serving previews drawn by the old code.
import { expect, test } from "bun:test";
import { RENDERER_VERSION } from "../report.ts";

test("the renderer version is a short code that stays the same for the same sources", async () => {
  expect(RENDERER_VERSION).toMatch(/^[0-9a-f]{16}$/);
  // Loading the module again (same files) gives the same code.
  const again = await import(`../report.ts?again=${Date.now()}`);
  expect(again.RENDERER_VERSION).toBe(RENDERER_VERSION);
});
