/**
 * The governorate and district written inside a free-text address.
 *
 * Names are matched as whole words, the longest first. A name that is only a street,
 * building or road («شارع بورسعيد», «طريق مصر السويس») does not place the address, and a
 * name that could be in two governorates is never guessed: the case then waits for review.
 */
export interface PlaceName {
  name: string;
  level: number;
  governorate: string | null;
}

export interface FoundPlace {
  governorate: string | null;
  district: string | null;
  /** The address itself names the governorate (it then beats a «governorate» column). */
  stated: boolean;
  /** The address also names a place in another governorate: a person decides. */
  conflict: boolean;
}

interface Entry {
  governorate: string;
  district: string | null;
}

export interface AddressIndex {
  byPhrase: Map<string, Entry[]>;
  longest: number;
}

/** An address as comparable words: spelling variants, digits and punctuation made one. */
export function addressWords(value: string): string[] {
  return (
    value
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/[ً-ٰٟـ]/g, "")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/[ىی]/g, "ي")
      .replace(/ة/g, "ه")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .replace(/ک/g, "ك")
      .toLowerCase()
      // «6اكتوبر» is two words.
      .replace(/(\d)([^\d\s])/g, "$1 $2")
      .replace(/([^\d\s])(\d)/g, "$1 $2")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).map((word) => (word.length > 4 && word.startsWith("ال") ? word.slice(2) : word));
}

/** Usual names that are not in the place list as people write them. */
const ALIASES: [written: string, governorate: string, district: string | null][] = [
  ["الاسماعيلية", "الإسماعلية", null],
  ["الاسكندرية", "الأسكندرية", null],
  ["اسكندرية", "الأسكندرية", null],
  ["البحر الاحمر", "البحر الأحمر", null],
  ["6 اكتوبر", "الجيزة", "السادس من أكتوبر"],
  ["6 من اكتوبر", "الجيزة", "السادس من أكتوبر"],
  ["مدينة اكتوبر", "الجيزة", "السادس من أكتوبر"],
  ["حدائق الاهرام", "الجيزة", "حدائق الأهرام"],
  ["شارع الهرم", "الجيزة", "الهرم"],
  ["شارع فيصل", "الجيزة", "فيصل"],
  ["التجمع الاول", "القاهرة", "القاهرة الجديدة"],
  ["التجمع الثالث", "القاهرة", "القاهرة الجديدة"],
  ["التجمع الخامس", "القاهرة", "القاهرة الجديدة"],
  ["10 من رمضان", "الشرقية", "العاشر من رمضان"],
  ["10 رمضان", "الشرقية", "العاشر من رمضان"],
  ["العاشر من رمضان", "الشرقية", "العاشر من رمضان"],
  ["العاشر", "الشرقية", "العاشر من رمضان"],
  ["مدينة العبور", "القليوبية", "العبور"],
  // East and west of a district, not the governorates of those names.
  ["عين شمس الشرقية", "القاهرة", "عين شمس"],
  ["عين شمس الغربية", "القاهرة", "عين شمس"],
];

/** District names that are also everyday words: they count only after «مركز», «قسم», «حي», «مدينة». */
const EVERYDAY = new Set(
  [
    "السلام", "النزهة", "العرب", "بدر", "نخل", "الوقف", "الروضة", "الحمام", "الطور", "باريس", "الساحل", "السيوف",
    "الرياض", "الشهداء", "المنشأة", "المنشية", "الكوثر", "الجامعة", "العدوة", "بلاط", "ناصر", "مقبل", "الصف",
    "السرو", "الزرقا", "اللبان", "الخليفة", "الظاهر", "الناصرية", "الجناين", "الحسنة", "العاشر", "مارينا",
    "السيالة", "الحادقة", "موط", "تلا", "العتبة", "الزيتون", "القصير", "الداخلة", "فيكتوريا",
  ].map((name) => addressWords(name).join(" ")),
);

const words = (...names: string[]) => new Set(names.flatMap(addressWords));
const PLACE_MARKERS = words("محافظه", "مركز", "قسم", "حي", "مدينه", "بندر");
/** The word before a name that makes it a street, a building or a business. */
const NOT_A_PLACE = words(
  "شارع", "ش", "طريق", "ط", "محور", "كوبري", "مسجد", "جامع", "كنيسه", "مدرسه", "مستشفي", "عماره", "برج", "ابراج",
  "صيدليه", "شركه", "مؤسسه", "بنك", "محل", "معرض", "فندق", "مول", "قهوه", "مقهي", "سوق", "حاره", "زقاق", "مطعم",
  "مصنع", "مكتب", "مكتبه", "سنترال", "مخبز", "مصر",
);

export function buildAddressIndex(places: PlaceName[]): AddressIndex {
  const byPhrase = new Map<string, Entry[]>();
  let longest = 1;
  const put = (written: string, entries: Entry[]) => {
    const parts = addressWords(written);
    if (!parts.length) return;
    longest = Math.max(longest, parts.length);
    byPhrase.set(parts.join(" "), entries);
  };
  const add = (written: string, entry: Entry) => {
    put(written, [...(byPhrase.get(addressWords(written).join(" ")) ?? []), entry]);
  };
  const governorates = new Map(
    places.filter((place) => place.level === 1).map((place) => [addressWords(place.name).join(" "), place.name]),
  );
  for (const place of places) {
    if (place.level === 1) add(place.name, { governorate: place.name, district: null });
    else if (place.level === 2 && place.governorate) add(place.name, { governorate: place.governorate, district: place.name });
  }
  // An alias is the answer for that name; its governorate uses the list's own spelling.
  for (const [written, governorate, district] of ALIASES) {
    const known = governorates.get(addressWords(governorate).join(" "));
    if (known) put(written, [{ governorate: known, district }]);
  }
  return { byPhrase, longest };
}

export function findPlace(address: string, index: AddressIndex): FoundPlace {
  const text = addressWords(address);
  const stated: string[] = [];
  const named: Entry[][] = [];
  let i = 0;
  while (i < text.length) {
    let size = Math.min(index.longest, text.length - i);
    let entries: Entry[] | undefined;
    let phrase = "";
    for (; size > 0; size -= 1) {
      phrase = text.slice(i, i + size).join(" ");
      entries = index.byPhrase.get(phrase);
      if (entries) break;
    }
    if (!entries) {
      i += 1;
      continue;
    }
    const before = i ? text[i - 1]! : "";
    const marked = PLACE_MARKERS.has(before);
    if (!NOT_A_PLACE.has(before) && (marked || !EVERYDAY.has(phrase))) {
      const governorate = entries.find((entry) => !entry.district);
      const districts = entries.filter((entry) => entry.district);
      if (governorate) stated.push(governorate.governorate);
      // A capital has its governorate's name: that names the governorate, not a district.
      if (districts.length && !governorate) named.push(districts);
    }
    i += size;
  }

  // The governorate is written last in an Egyptian address.
  const governorate = stated.at(-1) ?? null;
  if (governorate) {
    const district = named.flat().find((entry) => entry.governorate === governorate)?.district ?? null;
    const elsewhere = named.some((entries) => !entries.some((entry) => entry.governorate === governorate));
    return { governorate, district, stated: true, conflict: elsewhere || new Set(stated).size > 1 };
  }
  const nothing = { governorate: null, district: null, stated: false, conflict: false };
  if (!named.length) return nothing;
  const possible = named
    .map((entries) => new Set(entries.map((entry) => entry.governorate)))
    .reduce((all, next) => new Set([...all].filter((name) => next.has(name))));
  if (possible.size !== 1) return nothing;
  const only = [...possible][0]!;
  return { governorate: only, district: named[0]!.find((entry) => entry.governorate === only)!.district, stated: false, conflict: false };
}
