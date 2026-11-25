import { describe, expect, test } from "bun:test";
import { configuredInboxes } from "./inbox.ts";

describe("which inboxes are set on the server", () => {
  test("the short names: RETAIL holds the address, RETAIL_PASS its password", () => {
    const inboxes = configuredInboxes({
      RETAIL: "retail@example.com",
      RETAIL_PASS: "x",
      INFO: "info@example.com",
      INFO_PASS: "y",
      SME: "sme@example.com",
    });
    // SME has no password, so it is not an inbox.
    expect(inboxes.map((inbox) => [inbox.name, inbox.user])).toEqual([
      ["retail", "retail@example.com"],
      ["info", "info@example.com"],
    ]);
  });

  test("the long names still work and win", () => {
    const inboxes = configuredInboxes({ MAIL_INBOXES: "info", MAIL_INFO_USER: "a@example.com", MAIL_INFO_PASS: "p", INFO: "b@example.com" });
    expect(inboxes).toEqual([{ name: "info", user: "a@example.com", pass: "p" }]);
  });

  test("a short variable that is not an address is not an inbox", () => {
    expect(configuredInboxes({ INFO: "yes", INFO_PASS: "p" })).toEqual([]);
  });
});
