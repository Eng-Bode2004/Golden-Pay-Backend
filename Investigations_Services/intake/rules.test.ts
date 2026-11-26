import { describe, expect, test } from "bun:test";
import {
  areaTargets,
  cairoInstant,
  detectFast,
  detectKind,
  detectKnowledge,
  formFor,
  domainMatches,
  findNationalId,
  freshBody,
  isNationalId,
  isReplySubject,
  isSystemMail,
  kindsOverlap,
  normalizeMobile,
  releaseTime,
  requestKind,
  safeInlineType,
  samePerson,
  senderVerified,
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
    expect(detectKind("معاملات شركة تجريبية")).toBeNull();
  });

  test("fast only when marked, never from a legal footer", () => {
    expect(detectFast("Fast Track\nبرجاء اجراء استعلام سكن", [])).toBe(true);
    expect(detectFast("طلب عاجل تجريبي", [])).toBe(true);
    expect(detectFast("RE: استعجال", [])).toBe(true);
    expect(detectFast("Agency 01/01/2030 Auto cases 1", [])).toBe(false);
    expect(detectFast("any use is expressly prohibited", [])).toBe(false);
    expect(detectFast("VIP client", ["vip"])).toBe(true);
  });
});

describe("national IDs and phones", () => {
  test("valid IDs, Arabic digits included", () => {
    expect(isNationalId("29001011234567")).toBe(true);
    expect(isNationalId("٢٩٠٠١٠١١٢٣٤٥٦٧")).toBe(true);
    expect(isNationalId("29013011234567")).toBe(false); // month 13
    expect(isNationalId("1000000001")).toBe(false);
    expect(findNationalId("عميل تجريبي      29001011234567")).toBe("29001011234567");
  });

  test("mobiles in every common form", () => {
    expect(normalizeMobile("1001234567")).toBe("01001234567");
    expect(normalizeMobile("+20 100 123 4567")).toBe("01001234567");
    expect(normalizeMobile("0122 765 4321")).toBe("01227654321");
    expect(normalizeMobile("12345")).toBeNull();
  });
});

describe("what is not a new request", () => {
  test("replies, bounces and auto-replies", () => {
    expect(isReplySubject("RE: Home investigation")).toBe(true);
    expect(isReplySubject("رد: عميل جديد")).toBe(true);
    expect(isReplySubject("FW: Home investigation")).toBe(false);
    expect(isSystemMail("mailer-daemon@mail.example", "Message Delivery Failure")).toBe(true);
    expect(isSystemMail("postmaster@bank.example", "Undeliverable: request")).toBe(true);
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
      ["29002021234567", "الرقم القومي"],
      ["01011112222", "الموبايل"],
      ["عمارة 1 الدور الاول مجاورة 3 الحي الاول", "عنوان السكن"],
    ]);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ national_id: "29002021234567", home_address: "عمارة 1 الدور الاول مجاورة 3 الحي الاول" });
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

describe("what must never go out automatically", () => {
  test("signatures and form labels do not choose the form", () => {
    expect(detectKind("New request\nTeam Leader\nHead Office - Operations")).toBeNull();
    expect(detectKind("New request\nField Investigation Officer")).toBeNull();
    expect(detectKind("warehouse network officer")).toBeNull();
    expect(detectKind("استعلام سكن\nجهة العمل\nعنوان العمل")).toBe("home");
    expect(detectKind("Type: work\nHome address\nCompany Address")).toBe("work");
  });

  test("a forwarder's own line beats the email underneath", () => {
    expect(requestKind("FW: request", "استعلام سكن\n\nFrom: branch\nاستعلام عمل")).toBe("home");
    expect(requestKind("FW: request", "Good day\n\nFrom: branch\nHome investigation")).toBe("home");
  });

  test("only the mail server's DMARC pass verifies a sender", () => {
    expect(senderVerified("mx.example; spf=pass; dmarc=pass header.from=bank.example")).toBe(true);
    expect(senderVerified("mx.example; spf=pass; dmarc=fail header.from=bank.example")).toBe(false);
    expect(senderVerified('mx.example; spf=pass smtp.mailfrom="x; dmarc=pass"@evil.example; dmarc=fail')).toBe(false);
    expect(senderVerified(null)).toBe(false);
  });

  test("repeated requests are recognised", () => {
    expect(samePerson({ subject_name: "عميل  تجريبي" }, { subject_name: "عميل تجريبي" })).toBe(true);
    expect(samePerson({ subject_name: "أ", national_id: "1" }, { subject_name: "أ", national_id: "2" })).toBe(false);
    expect(samePerson({}, {})).toBe(false);
    expect(kindsOverlap("home", "home_work")).toBe(true);
    expect(kindsOverlap("home", "work")).toBe(false);
  });

  test("active content from an email is never shown", () => {
    for (const type of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", ""]) expect(safeInlineType(type)).toBeNull();
    expect(safeInlineType("application/pdf")).toBe("application/pdf");
  });
});

describe("customer knowledge and merchant visits", () => {
  test("with or without the customer's knowledge, as the client writes it", () => {
    expect(detectKnowledge("استعلام سكن فقط بعلم العميل")).toBe("with");
    expect(detectKnowledge("استعلام عمل - بعلم العميلة")).toBe("with");
    expect(detectKnowledge("مع علم العميل")).toBe("with");
    expect(detectKnowledge("استعلام سكن وعمل بدون علم العميل")).toBe("without");
    expect(detectKnowledge("دون علم العميل")).toBe("without");
    expect(detectKnowledge("من غير علم العميل")).toBe("without");
    expect(detectKnowledge("Home visit without customer knowledge")).toBe("without");
    expect(detectKnowledge("استعلام سكن فقط")).toBeNull();
    // «علم» alone, or about someone else, says nothing about the customer.
    expect(detectKnowledge("للعلم تم ارسال الطلب")).toBeNull();
  });

  test("«استعلام تجار» is a merchant visit; the commercial register is not", () => {
    expect(detectKind("استعلام تجار")).toBe("merchant_coding");
    expect(detectKind("ex merchant")).toBe("merchant_coding");
    expect(detectKind("مرفق السجل التجاري والبطاقة الضريبية")).toBeNull();
  });
});

describe("Mogo merchant sheet («استعلام تجار»)", () => {
  test("a label/value sheet that names the merchant is one business visit", () => {
    const rows = [
      ["اسم التاجر", "معرض النور للسيارات"],
      ["اسم الشخص المسؤول", "سامي فؤاد"],
      ["طبيعة النشاط", "تجارة سيارات"],
      ["العنوان بالتفصيل", "15 شارع التحرير، الدقي، الجيزة"],
      ["رقم التليفون", "01001234567"],
    ];
    const [item] = casesFromGrid(rows);
    expect(item?.subject_name).toBe("معرض النور للسيارات");
    expect(item?.kind).toBe("merchant_coding");
    expect(item?.home_address).toContain("شارع التحرير");
    expect(item?.phone).toBe("01001234567");
  });
});

describe("each business visit by its own type", () => {
  test("the words banks use pick the exact form", () => {
    expect(detectKind("استعلام اصحاب الاعمال")).toBe("business_owner");
    expect(detectKind("استعلام صاحب نشاط - مقر النشاط")).toBe("business_owner");
    expect(detectKind("استعلام عن الشركات الصغيرة والمتوسطة")).toBe("sme");
    expect(detectKind("SME visit")).toBe("sme");
    expect(detectKind("استعلام ميداني عن الشركة")).toBe("company");
    expect(detectKind("استعلام موردين")).toBe("supplier");
    expect(detectKind("زيارة مفاجئة للمقر")).toBe("site_visit");
    expect(detectKind("استعلام عيادة")).toBe("clinic");
    expect(detectKind("استعلام عن المعرض المرفق")).toBe("dealer_coding");
    expect(detectKind("تكويد معرض سيارات")).toBe("dealer_coding");
    expect(detectKind("تكويد كيان اعتباري")).toBe("company_coding");
    expect(detectKind("استعلام متابعة")).toBe("follow_up");
  });

  test("words in every email never decide the type", () => {
    // «assessment» holds «sme»; «شركة الاستعلام» is us; «Company Name» is a form label.
    expect(detectKind("Credit Card Assessment Center")).toBeNull();
    expect(detectKind("السادة / شركة الاستعلام تحية طيبة")).toBeNull();
    expect(detectKind("Name: x\nCompany Name: y")).toBeNull();
    expect(detectKind("السادة / شركة الاستعلام برجاء استعلام سكن")).toBe("home");
    expect(detectKind("برجاء المتابعة مع العميل استعلام عمل")).toBe("work");
  });
});

describe("the form for a kind", () => {
  test("its own form, else the client's general field-visit form (waiting for review)", () => {
    const templates = { home: "h", sme: "s", business: "s" };
    expect(formFor(templates, "home")).toEqual({ templateId: "h", fallback: false });
    expect(formFor(templates, "sme")).toEqual({ templateId: "s", fallback: false });
    expect(formFor(templates, "supplier")).toEqual({ templateId: "s", fallback: true });
    expect(formFor(templates, "work")).toBeNull();
    expect(formFor({ home: "h" }, "supplier")).toBeNull();
  });
});

describe("where an emailed case is offered", () => {
  test("the most exact place first, then each wider one", () => {
    const targets = areaTargets({ governorate: "المنوفية", district: "شبين الكوم", local_unit: "البتانون", main_village: "" });
    expect(targets.map((t) => t.area)).toEqual([
      { mode: "hierarchy", governorate: "المنوفية", district: "شبين الكوم", local_unit: "البتانون" },
      { mode: "hierarchy", governorate: "المنوفية", district: "شبين الكوم" },
      { mode: "hierarchy", governorate: "المنوفية" },
    ]);
  });

  test("governorate only, or nothing", () => {
    expect(areaTargets({ governorate: "القاهرة" }).map((t) => t.area)).toEqual([{ mode: "hierarchy", governorate: "القاهرة" }]);
    expect(areaTargets({ district: "مدينة نصر" })).toEqual([]);
  });
});
