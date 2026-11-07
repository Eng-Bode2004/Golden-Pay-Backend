// Classification of every original template from its content. Folder names are only hints:
// files without the client's name or logo inside must be confirmed by Head Office.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { inventoryDocx, layoutSimilarity, markSharedLayouts, type InventoryRecord } from "../inventory.ts";

const ARCHIVE = join(import.meta.dir, "..", "..", "..", "..", "Investigation Forms");
const CONVERTED = join(import.meta.dir, "..", "..", "..", "DynamicForms_Services", "Seeds", "converted-doc");

// folder → [client from content (null = must be confirmed), investigation type]
const EXPECTED: Record<string, [string | null, string]> = {
  "Abd el latif Gamel Company/نموذج تقرير إستعلام - تكويد تاجر": ["abd-ellatif-gamel", "merchant_coding"],
  "Abd el latif Gamel Company/نموذج تقرير إستعلام أفراد - (مقر سكن)": ["abd-ellatif-gamel", "residence"],
  "Abd el latif Gamel Company/نموذج تقرير إستعلام أفراد - (مقر عمل)": ["abd-ellatif-gamel", "employment"],
  "Abd el latif Gamel Company/نموذج تقرير إستعلام أفراد - صاحب نشاط (مقر نشاط)": ["abd-ellatif-gamel", "business_owner"],
  "Alex Bank/استعلام عمل": ["alex-bank", "employment"],
  "Alex Bank/استعلام مهن حرة سيدات": ["alex-bank", "business_owner"],
  "Bedayty Company/استعلام تاجر": [null, "merchant_coding"],
  "Bedayty Company/استعلام سكن": [null, "residence"],
  "Bedayty Company/استعلام عمل": [null, "employment"],
  "CIB Bank/استعلام موردين": [null, "supplier"],
  "CIB Bank/استعلام ميداني وزياره مفاجئه": ["cib", "sme"],
  "CIB Bank/تقرير استعلام المشروعات": ["cib", "sme"],
  "Credit agricole Bank/استعلام سكن": ["credit-agricole", "residence"],
  "Credit agricole Bank/استعلام شركات لأغراض التجزئة المصرفية": ["credit-agricole", "company"],
  "Credit agricole Bank/استعلام عمل": ["credit-agricole", "employment"],
  "Credit agricole Bank/استعلام عيادة": ["credit-agricole", "clinic"],
  "Credit agricole Bank/استعلام وتكويد موردين و وكلاء": ["credit-agricole", "supplier"],
  "Credit agricole Bank/تكويد معرض": ["credit-agricole", "dealer_coding"],
  "Gaboor Company/إستعلام تكويد شركات": ["ghabbour", "company_coding"],
  "Gaboor Company/استعلام عمل": ["ghabbour", "employment"],
  "Gaboor Company/استعلام منزل": ["ghabbour", "residence"],
  "Gaboor Company/استعلام منزل و عمل": ["ghabbour", "residence_employment"],
  "Global Company/استعلام سكن عميل": [null, "residence"],
  "Global Company/استعلام عمل": [null, "employment"],
  "Global Company/تكويد شركه": [null, "company_coding"],
  "Global Company/تكويد معرض سيارات": [null, "dealer_coding"],
  "Global Company/نموذج تكويد كيان اعتبارى": [null, "company_coding"],
  "Hermes Company/تقرير زيارة شركة": ["hermes", "site_visit"],
  "Industrial Development Bank/استعلام العمل": ["idb", "employment"],
  "Industrial Development Bank/استعلام سكن": ["idb", "residence"],
  "Industrial Development Bank/استعلام شركات": ["idb", "company_coding"],
  "Industrial Development Bank/استعلام موظف": ["idb", "employment"],
  "Industrial Development Bank/استعلام ميداني(موردين)": ["idb", "supplier"],
  "Med Bank/استعلام سكن": ["med-bank", "residence"],
  "Med Bank/استعلام عمل": ["med-bank", "employment"],
  "Mogo Company/استعلام تجار": ["mogo", "merchant_coding"],
  "Mogo Company/استعلام سكن": ["mogo", "residence"],
  "Mogo Company/استعلام عمل": ["mogo", "employment"],
  "One Fitness Company/تكويد معرض سيارات": [null, "dealer_coding"],
  "One Fitness Company/سكن": [null, "residence"],
  "One Fitness Company/صاحب نشاط": [null, "employment"],
  "One Fitness Company/عمل موظف": [null, "employment"],
  "One Fitness Company/نموذج تشطيب": [null, "employment"],
  "QNB Bank/استعلام اصحاب الاعمال": ["qnb", "business_owner"],
  "QNB Bank/استعلام عن الشركات الصغيرة والمتوسطــة": ["qnb", "sme"],
  "QNB Bank/تقرير سكن": ["qnb", "residence"],
  "QNB Bank/تقرير عمل": ["qnb", "employment"],
  "Rizk allah Company/استعلام سكن": [null, "residence"],
  "Rizk allah Company/استعلام عمل": [null, "employment"],
  "Tanmiya Company/استعلام شركة": ["tanmiya", "company"],
  "Tanmiya Company/استعلام متابعه": ["tanmiya", "follow_up"],
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

describe("archive inventory", () => {
  const records = new Map<string, InventoryRecord>();

  test("every original is read and classified from its content", async () => {
    expect(existsSync(ARCHIVE)).toBe(true);
    const all: InventoryRecord[] = [];
    for (const path of walk(ARCHIVE)) {
      const rel = relative(ARCHIVE, path).replaceAll("\\", "/");
      const [client, folder] = rel.split("/");
      const isDoc = path.toLowerCase().endsWith(".doc");
      const bytes = new Uint8Array(readFileSync(isDoc ? join(CONVERTED, `${client}__${folder}.docx`) : path));
      const record = await inventoryDocx(bytes, { fileName: basename(path), sourcePath: `${client}/${folder}`, format: isDoc ? "doc" : "docx" });
      records.set(`${client}/${folder}`, record);
      all.push(record);
    }
    markSharedLayouts(all);
    expect(records.size).toBe(51);
    const wrong: string[] = [];
    for (const [key, [client, type]] of Object.entries(EXPECTED)) {
      const record = records.get(key);
      if (!record) wrong.push(`${key}: missing`);
      else if (record.client.client_id !== client || record.investigation_type.code !== type) {
        wrong.push(`${key}: got ${record.client.client_id}/${record.investigation_type.code}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("a client is never assigned from the folder name alone", () => {
    for (const [key, record] of records) {
      if (EXPECTED[key]![0] === null) {
        expect(record.client.suggested).not.toBeNull();
        expect(record.warnings.some((warning) => warning.code === "client_uncertain" && warning.severity === "block")).toBe(true);
      }
    }
  });

  test("the folder «One Fitness» is One Finance, and title/folder type conflicts are flagged", () => {
    const record = records.get("One Fitness Company/صاحب نشاط")!;
    expect(record.client.suggested).toBe("one-finance");
    expect(record.warnings.some((warning) => warning.code === "type_uncertain")).toBe(true);
  });

  test("personal data from real reports is flagged so it never reaches a template", () => {
    const idb = records.get("Industrial Development Bank/استعلام موظف")!;
    expect(idb.warnings.filter((warning) => warning.code === "site_photo").length).toBeGreaterThanOrEqual(5);
    expect(idb.warnings.some((warning) => warning.code === "qr_code")).toBe(true);
    expect(records.get("QNB Bank/تقرير سكن")!.warnings.some((warning) => warning.code === "signature")).toBe(true);
    expect(records.get("Alex Bank/استعلام عمل")!.warnings.some((warning) => warning.code === "third_party_stamp")).toBe(true);
    expect(records.get("Bedayty Company/استعلام سكن")!.warnings.some((warning) => warning.code === "sample_date")).toBe(true);
  });

  test("identical layouts shared by different clients are recognised", () => {
    const [bedayty, global, med] = ["Bedayty Company/استعلام عمل", "Global Company/استعلام عمل", "Med Bank/استعلام عمل"].map(
      (key) => records.get(key)!,
    );
    expect(layoutSimilarity(bedayty!, global!)).toBeGreaterThanOrEqual(0.88);
    expect(layoutSimilarity(global!, med!)).toBeGreaterThanOrEqual(0.88);
    // Different clients' different forms are not confused.
    expect(layoutSimilarity(med!, records.get("QNB Bank/تقرير عمل")!)).toBeLessThan(0.5);
    expect(records.get("Med Bank/استعلام عمل")!.warnings.some((warning) => warning.code === "shared_layout")).toBe(true);
  });

  test("revisions are read from the document properties", () => {
    for (const record of records.values()) expect(record.version.label).toMatch(/مراجعة/);
  });
});
