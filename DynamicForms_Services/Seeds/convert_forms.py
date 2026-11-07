"""Converts Investigation Forms/*.docx into DynamicForms seed definitions.

Old .doc files cannot be parsed directly; save each as .docx into converted-doc/
named "<client folder>__<form folder>.docx".
"""
import json, os, re, sys, zipfile, hashlib
import xml.etree.ElementTree as ET

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "Investigation Forms")
SEEDS = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "forms.json")
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
W14 = "{http://schemas.microsoft.com/office/word/2010/wordml}"
MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
BOX = "☐"

CLIENTS = {
    "Abd el latif Gamel Company": ("abd-ellatif-gamel", "عبد اللطيف جميل", "company"),
    "Alex Bank": ("alex-bank", "بنك الإسكندرية", "bank"),
    "Bedayty Company": ("bedayty", "بدايتي", "company"),
    "CIB Bank": ("cib", "البنك التجاري الدولي CIB", "bank"),
    "Credit agricole Bank": ("credit-agricole", "بنك كريدي أجريكول", "bank"),
    "Gaboor Company": ("ghabbour", "جي بي أوتو (غبور)", "company"),
    "Global Company": ("global", "جلوبال", "company"),
    "Hermes Company": ("hermes", "هيرميس", "company"),
    "Industrial Development Bank": ("idb", "بنك التنمية الصناعية", "bank"),
    "Med Bank": ("med-bank", "ميد بنك", "bank"),
    "Mogo Company": ("mogo", "موجو", "company"),
    "One Fitness Company": ("one-finance", "وان فايننس", "company"),
    "QNB Bank": ("qnb", "بنك قطر الوطني QNB", "bank"),
    "Rizk allah Company": ("rizk-allah", "رزق الله", "company"),
    "Tanmiya Company": ("tanmiya", "تنمية", "company"),
}


def walk_text(node, out):
    for el in node:
        if el.tag == MC + "Fallback":
            continue
        if el.tag == W + "t":
            out.append(el.text or "")
        elif el.tag in (W + "tab", W + "br"):
            out.append(" ")
        elif el.tag == W + "sym" or el.tag == W14 + "checkbox" or el.tag == W + "checkBox":
            out.append(BOX)
            continue
        elif el.tag in (W + "drawing", W + "pict") or el.tag.endswith("AlternateContent"):
            # A drawn square beside option text works as a tick box. Text boxes
            # hold real content, which is kept.
            inner = []
            walk_text(el, inner)
            text = "".join(inner).strip()
            out.append(f" {text} " if text else BOX)
            continue
        walk_text(el, out)


def clean(text):
    text = text.replace("\u00a0", " ").replace("ـ", "")
    text = re.sub(r"[\u200e\u200f\u202a-\u202e\u2066-\u2069]", "", text)
    return re.sub(r"[ \t]+", " ", text).strip()


def para_text(p):
    out = []
    walk_text(p, out)
    return clean("".join(out))


def parse_table(tbl, lines):
    for tr in tbl.findall(W + "tr"):
        row = []
        for tc in tr.findall(W + "tc"):
            span = tc.find(f"{W}tcPr/{W}gridSpan")
            nested = tc.findall(W + "tbl")
            paras = [para_text(p) for p in tc.findall(W + "p")]
            paras = [p for p in paras if p]
            if nested:
                for table in nested:
                    parse_table(table, lines)
            row.append({"paras": paras, "span": int(span.get(W + "val")) if span is not None else 1})
        lines.append({"row": row})


def parse_body(parent, lines):
    for el in parent:
        if el.tag == W + "p":
            t = para_text(el)
            if t:
                lines.append({"p": t})
        elif el.tag == W + "tbl":
            parse_table(el, lines)
        elif el.tag == W + "sdt":
            content = el.find(W + "sdtContent")
            if content is not None:
                parse_body(content, lines)


def norm(label):
    label = re.sub(r"[:：\.\-–_…]+$", "", label).strip(" :/-–.()،")
    return re.sub(r"\s+", " ", label).replace(BOX, "").strip()


OPTION_WORDS = set("""ممتاز جيد جيدة جيده متوسط متوسطة متوسطه ضعيف ضعيفة ضعيفه راقي راقى راقية شعبي شعبية شعبى عشوائية ريفية متهالك قديم حديث
سهلة سهله صعبة صعبه تمليك مفروش اخرى أخرى آخر اخر شقة فيلا برج عمارة بيت محل مبنى طابق اعزب أعزب متزوج مطلق ارمل أرمل منفردا بمفرده الاهل الأهل
الزوجة اخرين آخرين رئيسي رئيسى جانبي جانبى حارة ممهد نعم لا صحيح خطأ خطا طيبة سيئة دائم مؤقت موجود غير موجود""".split()) | {
    "ايجار قديم", "ايجار جديد", "إيجار قديم", "إيجار جديد", "غير ممهد", "جيد جدا", "ضعيف جدا", "منزل العائلة", "مع عائلته", "مع الزوجة والاولاد",
    "لم يتم الوصول", "غير معروف", "غير مطابق", "مطابق", "مقابلة", "الزوجة وعدد الاولاد",
}
JUNK = re.compile(
    r"^(أولا|اولا|ثانيا|ثالثا|رابعا|خامسا|سادسا|سابعا)ً?$|جولدن با[يى]|مكتب الاستعلام|^UMPA$|مدير عام|^نجلاء سيد$|^خالد زكريا$|^عبدالحليم صلاح$|^لا العنوان|"
    r"^(نموذج|تقرير|أستعلام|استعلام|إستعلام)\b.{0,40}$"
)
AUTO = re.compile(
    r"^(اسم |أسم |إسم )?(ال)?(مستعلم|مراجع|متابع)(\b|$)|معد الزيارة|معد الاستعلام|تاريخ الاستعلام|توقيت الاستعلام|ختم|روجع بواسطة|توقيع|قرار (البنك|الشركة)|^بيانات شركة الاستعلام|^التاريخ$"
)
PREFILL = [
    (r"^(اسم|أسم|إسم) (العميل|السيد|السيدة|المورد|المستعلم عنه|طالب)|^الاسم$|^تقرير الاستعلام عن", "subject_name"),
    (r"العنوان المرسل|^عنوان العميل|^عنوان السكن|^العنوان( تفصيليا)?$", "address"),
    (r"^(ال)?محافظة$", "governorate"),
    (r"^(ال)?مدينة$|^المركز|^(ال)?قسم$", "district"),
    (r"علامة مميزة|العلامات المميزة", "landmark"),
    (r"^الرقم القوم[يى]$", "national_id"),
    (r"^رقم (التليفون|الهاتف|الموبايل)$|^(ال)?تليفون$|^موبايل", "phone"),
]


def field_type(label):
    if re.search(r"^تاريخ|تاريخ (بداية|بدء|التعيين|التأسيس)", label):
        return "date"
    if re.search(r"^(عدد|عدد سنوات|مساحة|مساحتها)", label):
        return "number"
    return "text"


class Builder:
    def __init__(self, title):
        self.title = title
        self.sections = [{"title": "البيانات الأساسية", "fields": []}]
        self.seen = set()
        self.notes = 0
        self.prefilled = set()

    def section(self, title):
        title = norm(title)
        if not title or AUTO.search(title):
            title = "ملاحظات"
        if not self.sections[-1]["fields"]:
            self.sections[-1]["title"] = title
        else:
            self.sections.append({"title": title, "fields": []})

    def add(self, label, kind=None, options=None, default=None):
        label = norm(label)
        if len(label) > 70 and kind != "textarea":
            label = norm(" ".join(label.split()[-3:]))
        if not label or AUTO.search(label) or len(label) > 70:
            return
        if kind != "textarea" and JUNK.search(label):
            return
        if not re.search(r"[\u0600-\u06ffA-Za-z]", label):
            return
        key = label
        if key in self.seen:
            n = 2
            while f"{key} {n}" in self.seen:
                n += 1
            if kind != "textarea" and n > 3:
                return
            key = f"{key} {n}"
        self.seen.add(key)
        field = {"key": "f" + hashlib.md5(key.encode()).hexdigest()[:10], "label": label, "type": kind or field_type(label), "required": False}
        if options:
            unique = []
            for o in options:
                if o and o not in unique:
                    unique.append(o)
            field["options"] = unique
        if default:
            field["default"] = default
        for pattern, target in PREFILL:
            if re.search(pattern, label) and target not in self.prefilled:
                field["prefill"] = target
                self.prefilled.add(target)
                break
        self.sections[-1]["fields"].append(field)

    def narrative(self, text, label=None):
        self.notes += 1
        self.add(label or ("تقرير المستعلم" if self.notes == 1 else f"تقرير المستعلم {self.notes}"), "textarea", default=text)

    def photos(self, label):
        self.add(label, "photos")


KNOWN = ["ايجار قديم", "ايجار جديد", "إيجار قديم", "إيجار جديد", "لم تتم الافادة", "لم تتم الإفادة", "خاص بالشركة", "جيد جدا", "جيد جداً", "ضعيف جدا", "لم يتم", "غير ممهد", "غير ممهده", "من خلال زيارة"]


def split_options(text):
    """Option words whose boxes were anchored together, e.g. 'ايجار قديم تمليك'."""
    if " / " in text:
        return [clean(x) for x in text.split("/") if clean(x)]
    for phrase in KNOWN:
        text = text.replace(phrase, phrase.replace(" ", "\u0001"))
    return [w.replace("\u0001", " ") for w in text.split()]


def looks_narrative(text):
    return len(text) > 75 or "( )" in text or "()" in text or "...." in text or "……" in text


def is_option_cell(text):
    if BOX in text:
        return True
    return bool(re.fullmatch(r"\S{2,12}( ?/ ?\S{2,12}){1,5}", text))


def inline(b, text):
    """Parses 'label : a ☐ b ☐ other label :' style lines."""
    text = re.sub(BOX + r"+", BOX, text)
    parts = re.split(r"[:：]", text)
    if len(parts) == 1:
        if BOX in text:
            pieces = [norm(x) for x in text.split(BOX) if norm(x)]
            if len(pieces) == 1:
                b.add(pieces[0], "yesno")
            elif pieces:
                label = b.pending if getattr(b, "pending", None) else "اختر"
                b.add(label, "choice", pieces)
                b.pending = None
            return
        m = re.match(r"^(.*?)\s+(نعم لا.*)$", text)
        if m:
            b.add(m.group(1), "choice", split_options(m.group(2)))
            return
        b.add(text)
        return
    label = parts[0]
    for i, value in enumerate(parts[1:], 1):
        value = value.strip()
        last = i == len(parts) - 1
        if BOX in value:
            pieces = [p.strip() for p in value.split(BOX)]
            tail = pieces[-1] if (not last or len(pieces[-1].split()) <= 3) and len(pieces) > 1 else ""
            options = [norm(p) for p in (pieces[:-1] if tail else pieces) if norm(p)]
            if tail and not last or (last and tail in ("عددها", "مساحتها")):
                b.add(label, "choice", options)
                if last:
                    b.add(tail)
                label = tail
                continue
            options = [norm(p) for p in pieces if norm(p)]
            b.add(label, "choice", options)
            label = ""
            continue
        m = re.match(r"^(.*?)(نعم لا( لم تتم الاف?ادة)?)\s*(.*)$", value)
        if m:
            b.add(label, "choice", split_options(m.group(2)))
            label = m.group(4) or ""
            continue
        value = re.sub(r"لم (تتم|نواف|نوافي|يتم)\S*( الاف?ادة)?", "", value).strip()
        if last:
            b.add(label, "textarea" if looks_narrative(value) else None, default=value if looks_narrative(value) else None)
            if value and not looks_narrative(value) and len(value.split()) <= 7:
                b.add(value)
        else:
            b.add(label)
            label = value


def collapse_options(fields, start):
    """Turns 'label | جيد | ممتاز' cells of one row into a single choice field."""
    i = start
    while i < len(fields):
        if fields[i]["type"] != "text" or fields[i]["label"] not in OPTION_WORDS:
            i += 1
            continue
        j = i
        while j < len(fields) and fields[j]["type"] == "text" and fields[j]["label"] in OPTION_WORDS:
            j += 1
        if j - i < 2:
            i = j
            continue
        run = [f["label"] for f in fields[i:j]]
        target = None
        if j < len(fields) and fields[j]["type"] == "text" and (i == start or j - start < len(fields) - start and i - start <= 0):
            target = j
        elif i > start and fields[i - 1]["type"] == "text":
            target = i - 1
        elif j < len(fields) and fields[j]["type"] == "text":
            target = j
        if target is None:
            i = j
            continue
        fields[target]["type"] = "choice"
        fields[target]["options"] = run
        del fields[i:j]
        i = start


def tidy(sections):
    for section in sections:
        fields = section["fields"]
        # A label cell beside its own report text appears twice.
        kept = []
        for field in fields:
            base = re.sub(r" \d+$", "", field["label"])
            if kept and field["type"] == "textarea" and kept[-1]["type"] == "text" and re.sub(r" \d+$", "", kept[-1]["label"]) == base:
                field["label"] = base
                kept[-1] = field
                continue
            kept.append(field)
        section["fields"] = kept
        for field in kept:
            if field["type"] == "text" and re.fullmatch(r"(.*?) ?صحيح خطأ.*", field["label"]):
                field["label"] = re.sub(r"صحيح خطأ( و الصحيح هو)?", "", field["label"]).strip() or "صحة البيانات"
                field["type"] = "choice"
                field["options"] = ["صحيح", "خطأ"]
    for section in sections:
        kinds = {field["type"] for field in section["fields"]}
        if kinds == {"photos"}:
            section["title"] = "الصور"
        elif re.match(r"^(نموذج|تقرير|أستعلام|استعلام|إستعلام)", section["title"]):
            section["title"] = "البيانات الأساسية"
    return [s for s in sections if s["fields"]]


def convert(lines, title):
    b = Builder(title)
    b.pending = None
    for line in lines:
        if "p" in line:
            text = line["p"]
            if not text.strip(BOX + " "):
                continue
            body = text.lstrip(BOX + " ")
            stripped = body if re.search(BOX, body) else clean(body)
            if re.search(r"^(أولا|اولا|ثانيا|ثالثا|رابعا|خامسا)ً?\s*[:：]?\s*(.+)$", stripped) and len(stripped) < 60:
                b.section(re.sub(r"^\S+\s*[:：]?\s*", "", stripped))
                continue
            if not stripped.strip():
                continue
            if re.match(r"^(صور|الصور|صورة)\b", stripped) and len(stripped) < 40:
                b.photos(stripped)
            elif looks_narrative(stripped) and BOX not in stripped and ":" not in stripped[:30] and stripped.count(":") < 2:
                b.narrative(stripped)
            elif ":" not in stripped and BOX not in stripped and "نعم لا" not in stripped and len(stripped.split()) <= 6:
                if stripped != title:
                    b.section(stripped)
            else:
                inline(b, stripped)
            continue

        row = [c for c in line["row"]]
        filled = [c for c in row if c["paras"]]
        if not filled:
            continue
        # Single merged cell: heading, or a block of inline fields.
        if len(filled) == 1 and len(filled[0]["paras"]) == 1 and len(row) == 1 or (len(filled) == 1 and len(row) > 1 and filled[0]["span"] > 1 and len(filled[0]["paras"][0]) < 45 and ":" not in filled[0]["paras"][0] and BOX not in filled[0]["paras"][0] and len(filled) == len(row)):
            t = filled[0]["paras"][0]
            if ":" not in t and BOX not in t and len(t) < 50 and "نعم لا" not in t:
                if re.match(r"^(صور|الصور)\b", t):
                    b.photos(t)
                else:
                    b.section(t)
                continue
        section = b.sections[-1]
        start = len(section["fields"])
        for index, cell in enumerate(row):
            if not cell["paras"]:
                continue
            joined = "\n".join(cell["paras"])
            flat = " ".join(cell["paras"])
            neighbour = None
            for j in (index + 1, index - 1):
                if 0 <= j < len(row) and row[j]["paras"]:
                    n = " ".join(row[j]["paras"])
                    if not is_option_cell(n) and not looks_narrative(n) and len(n) < 60:
                        neighbour = j
                        break
            if neighbour is not None and is_option_cell(flat) and not cell.get("used"):
                label = " ".join(row[neighbour]["paras"])
                body = flat.replace(BOX, " ")
                options = split_options(clean(body))
                if label and options:
                    b.add(label, "choice", options)
                    row[neighbour]["used"] = True
                    cell["used"] = True
                continue
            if cell.get("used"):
                continue
            if looks_narrative(flat) and ":" not in flat[:25]:
                label = " ".join(row[neighbour]["paras"]) if neighbour is not None else None
                if neighbour is not None:
                    row[neighbour]["used"] = True
                b.narrative(joined, norm(label) if label else None)
                continue
            for para in cell["paras"]:
                if ":" in para or BOX in para or "نعم لا" in para:
                    inline(b, para)
                elif looks_narrative(para):
                    b.narrative(para)
                else:
                    text = clean(para.replace(BOX, " "))
                    if len(cell["paras"]) == 1 and re.match(r"^[\d\s\-]+$", text):
                        continue
                    if re.match(r"^(أولا|اولا|ثانيا|ثالثا|رابعا|خامسا)ً?$", text):
                        continue
                    b.add(text)
        collapse_options(section["fields"], start)
    has_photos = any(f["type"] == "photos" for s in b.sections for f in s["fields"])
    if not has_photos:
        b.section("الصور والمرفقات")
        b.photos("صور الزيارة")
    return tidy(b.sections)


def category(name):
    n = name
    if re.search("تكويد|معرض|كيان|تشطيب", n):
        return "تكويد"
    if re.search("منزل و عمل", n):
        return "سكن وعمل"
    if re.search("سكن|منزل", n):
        return "سكن"
    if re.search("موردين|مورد|وكلاء", n):
        return "موردين"
    if re.search("تجار|تاجر|صاحب نشاط|اصحاب الاعمال|مقر نشاط|مهن حرة|عيادة", n):
        return "أصحاب نشاط"
    if re.search("شركات|شركة|مشروعات|ميداني", n):
        return "شركات"
    if re.search("متابع", n):
        return "متابعة"
    return "عمل"


def main():
    forms = []
    for base, _, files in os.walk(ROOT):
        for name in files:
            path = os.path.join(base, name)
            rel = os.path.relpath(path, ROOT).split(os.sep)
            client, folder = rel[0], rel[1]
            source = path
            if not name.lower().endswith(".docx"):
                source = os.path.join(SEEDS, "converted-doc", f"{client}__{folder}.docx")
                if not os.path.exists(source):
                    print("MISSING", client, folder, file=sys.stderr)
                    continue
            with zipfile.ZipFile(source) as z:
                root = ET.fromstring(z.read("word/document.xml"))
            lines = []
            parse_body(root.find(W + "body"), lines)
            title = clean(re.sub(r"نموذج تقرير |نموذج |^تقرير ", "", folder)) or folder
            sections = convert(lines, title)
            slug, client_ar, kind = CLIENTS[client]
            forms.append({
                "code": f"{slug}-{hashlib.md5(folder.encode()).hexdigest()[:6]}",
                "client_slug": slug,
                "client_name": client_ar,
                "client_type": kind,
                "title": folder.replace("نموذج تقرير ", "").strip(),
                "category": category(folder),
                "source_file": "/".join(rel),
                "sections": sections,
            })
    forms.sort(key=lambda f: (f["client_type"], f["client_name"], f["title"]))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(forms, open(OUT, "w", encoding="utf8"), ensure_ascii=False, indent=1)
    for f in forms:
        counts = {}
        for s in f["sections"]:
            for x in s["fields"]:
                counts[x["type"]] = counts.get(x["type"], 0) + 1
        print(f["client_slug"], "|", f["title"], "|", f["category"], "|", len(f["sections"]), "sec |", counts)


if __name__ == "__main__":
    main()
