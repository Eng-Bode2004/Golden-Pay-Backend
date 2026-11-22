import { describe, expect, test } from "bun:test";
import {
  cairoInstant,
  detectFast,
  detectKind,
  domainMatches,
  findNationalId,
  freshBody,
  isNationalId,
  isReplySubject,
  isSystemMail,
  normalizeMobile,
  releaseTime,
} from "./rules.ts";
import { casesFromGrid, fieldOfHeader, splitLabelledAddress } from "./tables.ts";
import { whyOpen } from "../followup.ts";

const cairo = (y: number, m: number, d: number, h: number, min = 0) => cairoInstant(y, m, d, h, min);

describe("when a case goes to investigators", () => {
  test("08:00 to 16:00 Cairo: at once", () => {
    for (const hour of [8, 11, 15]) {
      const at = cairo(2026, 11, 22, hour, 30);
      expect(releaseTime(at)).toEqual({ at, scheduled: false });
    }
  });

  test("16:00 and later: the next morning at 08:00", () => {
    for (const hour of [16, 19, 23]) {
      const result = releaseTime(cairo(2026, 11, 22, hour, 5));
      expect(result.scheduled).toBe(true);
      expect(result.at.getTime()).toBe(cairo(2026, 11, 23, 8).getTime());
    }
  });

  test("after midnight: the same morning at 08:00", () => {
    const result = releaseTime(cairo(2026, 11, 23, 2, 40));
    expect(result.at.getTime()).toBe(cairo(2026, 11, 23, 8).getTime());
  });

  test("month end rolls over", () => {
    expect(releaseTime(cairo(2026, 11, 30, 21)).at.getTime()).toBe(cairo(2026, 12, 1, 8).getTime());
  });

  test("Cairo summer time (UTC+3) is respected", () => {
    const morning = cairo(2026, 7, 10, 8);
    expect(morning.toISOString()).toBe("2026-07-10T05:00:00.000Z");
    expect(cairo(2026, 1, 10, 8).toISOString()).toBe("2026-01-10T06:00:00.000Z");
  });
});

describe("what the client asks for", () => {
  test("kinds as the clients write them", () => {
    expect(detectKind("استعلام سكن وعمل")).toBe("home_work");
    expect(detectKind("استعلام سكن و عمل")).toBe("home_work");
    expect(detectKind("استعلام سكن فقط")).toBe("home");
    expect(detectKind("FW: work and home investigation for id 1000")).toBe("home_work");
    expect(detectKind("Home investigation CID 1000000001")).toBe("home");
    expect(detectKind("استعلام عمل")).toBe("work");
    expect(detectKind("برجاء اعداد استعلام ميداني")).toBe("business");
    expect(detectKind("تشطيب وحده")).toBe("finishing");
  });

  test("«عملاء» and «معاملات» are not «عمل»", () => {
    expect(detectKind("عملاء اليوم")).toBeNull();
    expect(detectKind("معاملات شركة جميل للتمويل")).toBeNull();
  });

  test("fast only when marked, never from a legal footer", () => {
    expect(detectFast("Fast Track\nبرجاء اجراء استعلام سكن", [])).toBe(true);
    expect(detectFast("استعلام عاجل عن مستعلمين جدد", [])).toBe(true);
    expect(detectFast("RE: استعجال", [])).toBe(true);
    expect(detectFast("Golden 03/11/2026 Auto cases 1", [])).toBe(false);
    expect(detectFast("any use is expressly prohibited", [])).toBe(false);
    expect(detectFast("VIP client", ["vip"])).toBe(true);
  });
});

describe("national IDs and phones", () => {
  test("valid IDs, Arabic digits included", () => {
    expect(isNationalId("29001011234567")).toBe(true);
    expect(isNationalId("٢٩٠٠١٠١١٢٣٤٥٦٧")).toBe(true);
    expect(isNationalId("29013011234567")).toBe(false); // month 13
    expect(isNationalId("1002638866")).toBe(false);
    expect(findNationalId("عميل تجريبي      29001011234567")).toBe("29001011234567");
  });

  test("mobiles in every common form", () => {
    expect(normalizeMobile("1001234567")).toBe("01001234567");
    expect(normalizeMobile("+20 100 123 4567")).toBe("01001234567");
    expect(normalizeMobile("0122 765 4321")).toBe("01227654321");
    expect(normalizeMobile("16300")).toBeNull();
  });
});

describe("what is not a new request", () => {
  test("replies, bounces and auto-replies", () => {
    expect(isReplySubject("RE: Home investigation")).toBe(true);
    expect(isReplySubject("رد: عميل جديد")).toBe(true);
    expect(isReplySubject("FW: Home investigation")).toBe(false);
    expect(isSystemMail("mailer-daemon@secureserver.net", "Message Delivery Failure")).toBe(true);
    expect(isSystemMail("postmaster@boa.egypt", "Undeliverable: احمد")).toBe(true);
    expect(isSystemMail("a@bank.example", "Home investigation")).toBe(false);
  });

  test("quoted history is cut", () => {
    expect(freshBody("استعلام سكن\n\nFrom: someone\nold text")).toBe("استعلام سكن");
  });

  test("domains and subdomains", () => {
    expect(domainMatches("bank.example", ["bank.example"])).toBe(true);
    expect(domainMatches("mail.bank.example", ["@bank.example"])).toBe(true);
    expect(domainMatches("notbank.example", ["bank.example"])).toBe(false);
  });
});

describe("tables", () => {
  test("headers in English and Arabic; partner columns skipped", () => {
    expect(fieldOfHeader("Client`s Name (Arabic)")).toBe("subject_name");
    expect(fieldOfHeader("Business Address")).toBe("work_address");
    expect(fieldOfHeader("Inqury Address")).toBe("home_address");
    expect(fieldOfHeader("البطاقة رقم قومي لصاحب الطلب")).toBe("national_id");
    expect(fieldOfHeader("البطاقة رقم قومي للشريك")).toBeNull();
    expect(fieldOfHeader("Credit Analyst")).toBeNull();
  });

  test("a batch sheet becomes one case per row", () => {
    const cases = casesFromGrid([
      ["Sr", "Client`s Name (Arabic)", "Mobile", "Verification Required", "Home Address", "Business Address", "Governorate"],
      ["1", "عميلة تجريبية أولى", "1001234567", "عمل", "", "رقم 1 شارع تجريبي", "القاهره"],
      ["2", "عميل تجريبي ثان", "1007654321", "سكن", "شارع تجريبي 2", "", "الجيزة"],
      ["", "", "", "", "", "", ""],
    ]);
    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({ subject_name: "عميلة تجريبية أولى", phone: "01001234567", kind: "work", governorate: "القاهره" });
    expect(cases[1]?.kind).toBe("home");
  });

  test("a one-person sheet written as label | value", () => {
    const cases = casesFromGrid([
      ["عميل تجريبي", "اسم العميل"],
      ["28802011234567", "الرقم القومي"],
      ["01011112222", "الموبايل"],
      ["عمارة 1 الدور الاول مجاورة 3 الحي الاول", "عنوان السكن"],
    ]);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ national_id: "28802011234567", home_address: "عمارة 1 الدور الاول مجاورة 3 الحي الاول" });
  });

  test("«Governate : … , Area : …» addresses are split", () => {
    expect(splitLabelledAddress("Governate : القاهرة , Area : حي حلوان , Street : شارع 9")).toMatchObject({
      governorate: "القاهرة",
      district: "حي حلوان",
    });
  });
});

describe("why a case is still open", () => {
  const base = { due_at: null, assignee_name: null, pool_size: null, offers: 0, declined: 0, excuses: 0, created_at: new Date() };
  test("nobody in the area", () => {
    expect(whyOpen({ ...base, status: "unassigned", pool_size: 0 }).reason).toContain("لا يوجد مستعلم");
  });
  test("late at the investigator", () => {
    const row = { ...base, status: "in_progress", assignee_name: "أحمد", due_at: new Date(Date.now() - 3_600_000) };
    expect(whyOpen(row)).toEqual({ reason: "متأخرة عند أحمد", level: "late" });
  });
});
