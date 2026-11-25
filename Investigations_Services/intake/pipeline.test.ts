import { describe, expect, test } from "bun:test";
import { buildAddressIndex, findPlace } from "./address-place.ts";
import { gatherFiles, type Attachment } from "./files.ts";
import { aboutEarlierCases, cairoInstant, cleanText, kindOfRow, sendTime, sniffType, visitsFor } from "./rules.ts";
import { pickForms } from "./setup.ts";
import { csvGrid, isTrackerGrid } from "./tables.ts";

// Invented data only: this repository is public.
const seed = (await Bun.file(new URL("../../Investigators_Services/Seeds/egypt.json", import.meta.url)).json()) as {
  name: string;
  districts: { name: string }[];
}[];
const index = buildAddressIndex(
  seed.flatMap((governorate) => [
    { name: governorate.name, level: 1, governorate: null },
    ...governorate.districts.map((district) => ({ name: district.name, level: 2, governorate: governorate.name })),
  ]),
);
const at = (address: string) => {
  const { governorate, district } = findPlace(address, index);
  return [governorate, district];
};

describe("the place inside an address", () => {
  test("named with the governorate, or by a district alone", () => {
    expect(at("12 شارع تجريبي، مدينة نصر، القاهرة")).toEqual(["القاهرة", "مدينة نصر"]);
    expect(at("5 شارع تجريبي - سموحة")).toEqual(["الأسكندرية", "سموحة"]);
    expect(at("قرية تجريبية مركز أشمون")).toEqual(["المنوفية", "أشمون"]);
  });

  test("common ways of writing it", () => {
    expect(at("عمارة 3 الحي الاول 6اكتوبر")).toEqual(["الجيزة", "السادس من أكتوبر"]);
    expect(at("فيلا 4 التجمع الخامس")).toEqual(["القاهرة", "القاهرة الجديدة"]);
    expect(at("مجاورة ٩ العاشر من رمضان")).toEqual(["الشرقية", "العاشر من رمضان"]);
  });

  test("a street or a business named after a place is not that place", () => {
    expect(at("12 شارع بورسعيد")).toEqual([null, null]);
    expect(at("طريق السويس")).toEqual([null, null]);
    expect(at("شركة المنصورة للتجارة")).toEqual([null, null]);
    expect(at("7 شارع بورسعيد، الزاوية الحمراء")).toEqual(["القاهرة", "الزاوية الحمراء"]);
  });

  test("a name in two governorates is never guessed", () => {
    expect(at("4 شارع تجريبي، المطرية")).toEqual([null, null]);
    expect(at("4 شارع تجريبي، المطرية، القاهرة")).toEqual(["القاهرة", "المطرية"]);
  });

  test("east and west of a district are not governorates", () => {
    expect(at("4 شارع تجريبي عين شمس الشرقية")).toEqual(["القاهرة", "عين شمس"]);
  });

  test("an address naming two governorates is flagged", () => {
    expect(findPlace("كفر الدوار البحيرة ومحل اخر الاسكندرية", index).conflict).toBe(true);
    expect(findPlace("سموحة القاهرة", index).conflict).toBe(true);
    expect(findPlace("مدينة نصر القاهرة", index).conflict).toBe(false);
  });

  test("an everyday word is not a district", () => {
    expect(at("عمارة ناصر بجوار السلام")).toEqual([null, null]);
  });
});

describe("when a ready case goes out", () => {
  const cairo = (day: number, hour: number, minute = 0) => cairoInstant(2030, 1, day, hour, minute).getTime();
  const send = (arrived: number, now: number) => sendTime(new Date(arrived), new Date(now)).getTime();

  test("read within minutes in the day: at once, also just before 16:00", () => {
    expect(send(cairo(7, 10), cairo(7, 10, 2))).toBe(cairo(7, 10, 2));
    expect(send(cairo(7, 15, 59), cairo(7, 16, 3))).toBe(cairo(7, 16, 3));
  });

  test("the night's email goes at 08:00", () => {
    expect(send(cairo(7, 23), cairo(7, 23, 5))).toBe(cairo(8, 8));
    expect(send(cairo(7, 23), cairo(8, 9))).toBe(cairo(8, 9));
  });

  test("approved in the evening never wakes anyone", () => {
    expect(send(cairo(7, 12), cairo(7, 20))).toBe(cairo(8, 8));
  });
});

describe("what to visit", () => {
  test("home and work split only without a combined form", () => {
    expect(visitsFor("home_work", { home: "h", work: "w" })).toEqual(["home", "work"]);
    expect(visitsFor("home_work", { home: "h", work: "w", home_work: "b" })).toEqual(["home_work"]);
    expect(visitsFor("home_work", { home: "h" })).toEqual(["home_work"]);
  });

  test("a row without a type column suggests one", () => {
    expect(kindOfRow({ home_address: "a", work_address: "b" })).toBe("home_work");
    expect(kindOfRow({ home_address: "a", work_address: "b", company: "بدون استعلام عمل" })).toBe("home");
    expect(kindOfRow({ home_address: null, work_address: null })).toBeNull();
  });

  test("forms are picked only without doubt", () => {
    const forms = [
      { template_id: "h", title: "استعلام سكن", investigation_type: "residence" },
      { template_id: "w", title: "استعلام العمل", investigation_type: "employment" },
      { template_id: "e", title: "استعلام موظف", investigation_type: "employment" },
      { template_id: "c", title: "استعلام شركات", investigation_type: "company" },
      { template_id: "s", title: "تقرير مشروعات", investigation_type: "sme" },
    ];
    expect(pickForms(forms)).toEqual({ home: "h", work: "w" });
  });

  test("Mogo's «استعلام تجار» is its merchant visit; a company form still comes first elsewhere", () => {
    const mogo = [
      { template_id: "h", title: "استعلام سكن", investigation_type: null },
      { template_id: "w", title: "استعلام عمل", investigation_type: null },
      { template_id: "m", title: "استعلام تجار", investigation_type: null },
    ];
    expect(pickForms(mogo)).toEqual({ home: "h", work: "w", business: "m" });
    const bank = [
      { template_id: "c", title: "استعلام شركات", investigation_type: "company" },
      { template_id: "o", title: "استعلام أصحاب الاعمال", investigation_type: "business_owner" },
    ];
    expect(pickForms(bank)).toEqual({ business: "c" });
  });
});

describe("lists that are not new requests", () => {
  test("reminders and corrections by subject", () => {
    for (const subject of ["reminder", "FW: استعجال", "لتعديل اسم العميل", "Pending"]) expect(aboutEarlierCases(subject)).toBe(true);
    for (const subject of ["استعلام سكن", "طلب استعلام عاجل"]) expect(aboutEarlierCases(subject)).toBe(false);
  });

  test("billing and tracker sheets", () => {
    expect(isTrackerGrid([["اسم العميل", "العنوان", "السعر"]])).toBe(true);
    expect(isTrackerGrid([["اسم العميل", "الموقف", "تاريخ الارسال"]])).toBe(true);
    expect(isTrackerGrid([["Customer Name", "Home Address", "Credit Analyst"]])).toBe(false);
  });
});

describe("files", () => {
  test("CSV with quotes, commas and semicolons", () => {
    expect(csvGrid('a,b\n"x, y","say ""hi"""\n')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
    expect(csvGrid("a;b\r\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  test("the real type comes from the bytes", () => {
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffType(new TextEncoder().encode("<html>"))).toBeNull();
  });

  test("what nobody read is reported, never dropped", async () => {
    const file = (name: string, type: string): Attachment => ({ index: 0, name, type, bytes: 20_000, path: name });
    const out = await gatherFiles(
      [file("a.pdf", "application/pdf"), file("b.rar", "application/x-rar"), file("c.png", "image/png")],
      async (path) => new TextEncoder().encode(path === "a.pdf" ? "%PDF-1.4" : "not an image"),
    );
    expect(out.pdfs.map((pdf) => pdf.name)).toEqual(["a.pdf"]);
    expect(out.unread).toEqual(["b.rar", "c.png"]);
  });

  test("text PostgreSQL accepts", () => {
    expect(cleanText("a\u0000b")).toBe("ab");
    expect(cleanText("x\ud83d")).toBe("x�");
  });
});
