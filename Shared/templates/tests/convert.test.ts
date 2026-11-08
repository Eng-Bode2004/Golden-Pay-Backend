// A conversion whose request has gone away before its turn is skipped, so it does not
// hold up the previews and reports queued behind it.
import { expect, test } from "bun:test";
import { ConversionCancelled, docxToPdf } from "../convert.ts";

test("a cancelled conversion is skipped before it starts", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(docxToPdf(new Uint8Array([1, 2, 3]), controller.signal)).rejects.toBeInstanceOf(ConversionCancelled);
});
