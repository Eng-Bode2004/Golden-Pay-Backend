/** Why an investigator could not find the person: the "negative investigation" reasons. */
export const NEGATIVE_REASONS = [
  "العنوان غير صحيح أو غير موجود",
  "الشخص غير مقيم بالعنوان",
  "الشخص انتقل إلى عنوان آخر",
  "الشخص لا يعمل بجهة العمل المذكورة",
  "جهة العمل مغلقة أو غير موجودة",
  "المكان مغلق أثناء الزيارة",
  "لم يتعرف عليه الجيران أو المصادر",
  "رفض الشخص أو أسرته التعاون",
  "الهاتف مغلق أو لا يرد",
  "تعذّر الوصول إلى المنطقة",
  "بيانات الشخص غير مطابقة",
  "أخرى",
] as const;

export const LOCATION_KINDS = ["accepted", "started", "draft", "photo", "submitted"] as const;
