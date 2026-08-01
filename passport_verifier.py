"""
Passport verification pipeline — completely separate from ID (id_verifier.py).

ID       -> id_verifier.extract_id_info  + POST /verify-id
Passport -> this module                  + POST /verify-passport

When you send the final passport rules, we will update ONLY this file.
"""
import re

import id_verifier as idv

# Shared OCR / helpers from ID module (read-only reuse; ID logic is not modified here)
ocr_image = idv.ocr_image
ocr_image_ex = idv.ocr_image_ex
_GEO_RE = idv._GEO_RE
_fix_georgian_card_number = idv._fix_georgian_card_number
_normalize_mrz_line = idv._normalize_mrz_line
_fix_mrz_line = idv._fix_mrz_line
_mrz_personal_from_raw = idv._mrz_personal_from_raw
_parse_visual_fields = idv._parse_visual_fields
_ids_near_labels = idv._ids_near_labels
_value_after_labels = idv._value_after_labels
_personal_id_from_layout = idv._personal_id_from_layout
_pick_personal_id = idv._pick_personal_id
_find_personal_ids = idv._find_personal_ids
_georgian_only = idv._georgian_only
_restore_final_i = idv._restore_final_i
_birth_place_from_back = idv._birth_place_from_back
_split_pair = idv._split_pair
_birth_place_latin_from_back = idv._birth_place_latin_from_back
_correct_geo_using_latin = idv._correct_geo_using_latin
_repair_place_geo = idv._repair_place_geo
_is_place_junk = idv._is_place_junk
_format_citizenship = idv._format_citizenship
_format_gender_display = idv._format_gender_display
_parse_gender = idv._parse_gender
_format_bilingual = idv._format_bilingual
_norm_cmp = idv._norm_cmp
_gender_letter = idv._gender_letter
_latin_from_bilingual = idv._latin_from_bilingual
_best_geo_for_latin = idv._best_geo_for_latin
_collect_geo_name_candidates = idv._collect_geo_name_candidates
_geo_match_score = idv._geo_match_score
_find_dates_in_text = idv._find_dates_in_text
_normalize_display_date = idv._normalize_display_date
_correct_geo_using_latin = idv._correct_geo_using_latin
_soft_date_ocr = idv._soft_date_ocr
transliterate_ka = idv.transliterate_ka
_latin_norm = idv._latin_norm
_clean_place_latin = idv._clean_place_latin

# Labels / field titles that must never be treated as a person name
_PASSPORT_NAME_JUNK = re.compile(
    r"ქვეყნ|კოდი|მოქალაქ|საქართველ|პასპორტ|გაცემ|დაბადებ|"
    r"სახელი|გვარი|თარიღ|ადგილ|ნომერ|სქესი|ხელმოწერ|"
    r"authority|georgia|passport|surname|given|name|code|national|"
    r"date|issue|birth|sex|expiry|valid|personal",
    re.IGNORECASE,
)


def _is_passport_name_junk(value: str) -> bool:
    geo = _georgian_only(value) or ""
    if not geo or len(geo) < 2:
        return True
    if _PASSPORT_NAME_JUNK.search(geo) or _PASSPORT_NAME_JUNK.search(value or ""):
        return True
    return False


def _fix_passport_geo_name(geo: str, latin_hint: str) -> str:
    """
    Repair OCR Georgian name using MRZ Latin — without inventing extra letters.

    Never append «ი» when transliteration already matches MRZ (that caused
    გია→გიაი, დავით→დავითი, კალანდაძე→კალანდაძეი).
    """
    geo = (_georgian_only(geo) or geo or "").strip()
    if not geo:
        return ""
    hint = _latin_norm(latin_hint)
    orig = geo

    if hint:
        geo = _correct_geo_using_latin(geo, latin_hint)
        # Keep real final «ი» when MRZ Latin drops it (მირხანი ↔ MIRKHAN).
        # Do not restore after a vowel (გიაი / კალანდაძეი).
        if (
            orig.endswith("ი")
            and not geo.endswith("ი")
            and len(orig) >= 2
            and orig[-2] not in "აეოუ"
            and _latin_norm(transliterate_ka(orig)) == hint + "I"
            and _latin_norm(transliterate_ka(geo)) == hint
        ):
            geo = orig

    base = _latin_norm(transliterate_ka(geo)) if geo else ""

    # Exact match → leave as-is (do not append ი)
    if hint and base == hint:
        return geo

    # Spurious trailing ი after a vowel when stem matches MRZ
    if hint and geo.endswith("ი") and len(geo) >= 2 and geo[-2] in "აეოუ":
        without = geo[:-1]
        if _latin_norm(transliterate_ka(without)) == hint:
            return without

    # Latin ends with I but Georgian lost final ი (გიორგ → GIORGI)
    if hint and hint.endswith("I") and not geo.endswith("ი"):
        trial = geo + "ი"
        if _latin_norm(transliterate_ka(trial)) == hint:
            return trial

    return geo


def _passport_georgian_names(lines: list[str], mrz_first: str, mrz_last: str) -> dict:
    """
    Pick Georgian first/last using MRZ Latin as source of truth.
    Rejects passport field titles like «ქვეყნის კოდი».
    """
    raw = _collect_geo_name_candidates(lines)
    candidates = [c for c in raw if not _is_passport_name_junk(c)]

    extra = []
    for line in lines:
        geo = _georgian_only(line)
        if not geo or _is_passport_name_junk(geo):
            continue
        parts = [p for p in re.split(r"\s+", geo) if len(p) >= 2 and not _is_passport_name_junk(p)]
        for p in parts:
            if p not in candidates and p not in extra:
                extra.append(p)
    candidates = candidates + [e for e in extra if e not in candidates]

    out: dict = {}
    if mrz_last:
        best = _best_geo_for_latin(candidates, mrz_last)
        if best and _geo_match_score(best, mrz_last) >= 0.4:
            out["last_name"] = _fix_passport_geo_name(best, mrz_last)
    if mrz_first:
        used = {out.get("last_name", "")}
        best = _best_geo_for_latin(candidates, mrz_first, used)
        if best and _geo_match_score(best, mrz_first) >= 0.4:
            out["first_name"] = _fix_passport_geo_name(best, mrz_first)

    if not out.get("last_name"):
        labeled = _value_after_labels(lines, ["გვარი", "surname", "family name"], prefer_georgian=True)
        if labeled and not _is_passport_name_junk(labeled):
            if not mrz_last or _geo_match_score(labeled, mrz_last) >= 0.35:
                out["last_name"] = _fix_passport_geo_name(_georgian_only(labeled) or labeled, mrz_last)
    if not out.get("first_name"):
        labeled = _value_after_labels(
            lines, ["სახელი", "given name", "given names", "first name"], prefer_georgian=True
        )
        if labeled and not _is_passport_name_junk(labeled):
            if not mrz_first or _geo_match_score(labeled, mrz_first) >= 0.35:
                out["first_name"] = _fix_passport_geo_name(_georgian_only(labeled) or labeled, mrz_first)

    if mrz_first and mrz_last and out.get("first_name") and out.get("last_name"):
        ok = _geo_match_score(out["first_name"], mrz_first) + _geo_match_score(out["last_name"], mrz_last)
        swapped = _geo_match_score(out["first_name"], mrz_last) + _geo_match_score(out["last_name"], mrz_first)
        if swapped > ok + 0.3:
            out["first_name"], out["last_name"] = out["last_name"], out["first_name"]

    return out


# Passport DATE OF ISSUE is ALWAYS verbal month, never DD.MM.YYYY on the card:
#   «18 ივლ / JUL 2023»  →  18.07.2023
_GEO_MONTH = {
    "იან": 1, "იანვ": 1, "იანვარ": 1,
    "თებ": 2, "თებერ": 2, "თებერვა": 2,
    "მარ": 3, "მარტ": 3,
    "აპრ": 4, "აპრი": 4, "აპრილ": 4,
    "მაი": 5, "მაის": 5,
    "ივნ": 6, "ივნის": 6,
    "ივლ": 7, "ივლის": 7,
    "აგვ": 8, "აგვის": 8, "აგვისტ": 8,
    "სექ": 9, "სექტ": 9, "სექტემბ": 9,
    "ოქტ": 10, "ოქტო": 10, "ოქტომბ": 10,
    "ნოე": 11, "ნოემ": 11, "ნოემბ": 11,
    "დეკ": 12, "დეკე": 12, "დეკემბ": 12,
}
_LAT_MONTH = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
    "JANUARY": 1, "FEBRUARY": 2, "MARCH": 3, "APRIL": 4, "JUNE": 6,
    "JULY": 7, "AUGUST": 8, "SEPTEMBER": 9, "OCTOBER": 10, "NOVEMBER": 11, "DECEMBER": 12,
    # OCR noise
    "JUI": 7, "JU1": 7, "JVL": 7, "AU6": 8, "0CT": 10, "N0V": 11,
}


def _geo_month_num(token: str) -> int:
    if not token:
        return 0
    t = token.strip()
    for n in (8, 7, 6, 5, 4, 3):
        if len(t) >= min(3, n) and t[:n] in _GEO_MONTH:
            return _GEO_MONTH[t[:n]]
    return _GEO_MONTH.get(t[:3], 0)


def _lat_month_num(token: str) -> int:
    if not token:
        return 0
    u = re.sub(r"[^A-Z0-9]", "", token.upper())
    return _LAT_MONTH.get(u, 0) or _LAT_MONTH.get(u[:3], 0)


def _parse_passport_month_date(text: str) -> str:
    """
    Passport issue date is ALWAYS verbal month on every Georgian passport:
      18 ივლ / JUL 2023
      06 სექ / SEP 2018
      18 ივლ 2023
      18 JUL 2023
    → DD.MM.YYYY

    Do NOT run digit soft-OCR on the whole string first — it turns SEP→5EP.
    """
    if not text:
        return ""

    def _try(t: str) -> str:
        t = re.sub(r"\s+", " ", t).strip()
        # Allow missing space: 06სექ / SEP 2018
        t = re.sub(r"(?<=\d)(?=[\u10D0-\u10FF])", " ", t)
        t = re.sub(r"(?<=\d)(?=[A-Za-z])", " ", t)

        # Canonical: 18 ივლ / JUL 2023
        m = re.search(
            r"(?<!\d)(\d{1,2})\s+"
            r"([\u10D0-\u10FF]{2,12})\s*/\s*"
            r"([A-Za-z]{3,9})\s+"
            r"(\d{4})(?!\d)",
            t,
        )
        if m:
            day, geo_m, lat_m, year = m.group(1), m.group(2), m.group(3), m.group(4)
            month = _geo_month_num(geo_m) or _lat_month_num(lat_m)
            if month:
                return _normalize_display_date(day, str(month), year)

        # Optional slash missing: 18 ივლ JUL 2023
        m = re.search(
            r"(?<!\d)(\d{1,2})\s+"
            r"([\u10D0-\u10FF]{2,12})\s+"
            r"([A-Za-z]{3,9})\s+"
            r"(\d{4})(?!\d)",
            t,
        )
        if m:
            day, geo_m, lat_m, year = m.group(1), m.group(2), m.group(3), m.group(4)
            month = _geo_month_num(geo_m) or _lat_month_num(lat_m)
            if month:
                return _normalize_display_date(day, str(month), year)

        # Georgian month only: 18 ივლ 2023
        m = re.search(
            r"(?<!\d)(\d{1,2})\s+([\u10D0-\u10FF]{2,12})\s+(\d{4})(?!\d)",
            t,
        )
        if m:
            day, geo_m, year = m.group(1), m.group(2), m.group(3)
            month = _geo_month_num(geo_m)
            if month:
                return _normalize_display_date(day, str(month), year)

        # Latin month only: 18 JUL 2023 / 18/JUL/2023
        m = re.search(
            r"(?<!\d)(\d{1,2})\s*[./\-\s]+\s*([A-Za-z]{3,9})\s*[./\-\s]+\s*(\d{4})(?!\d)",
            t,
        )
        if m:
            day, lat_m, year = m.group(1), m.group(2), m.group(3)
            month = _lat_month_num(lat_m)
            if month:
                return _normalize_display_date(day, str(month), year)

        # Split tokens across OCR fragments
        parts = re.findall(r"\d{1,2}|[\u10D0-\u10FF]{2,12}|[A-Za-z]{3,9}|\d{4}", t)
        if len(parts) >= 3:
            for i in range(len(parts) - 2):
                if not parts[i].isdigit() or len(parts[i]) > 2:
                    continue
                day = parts[i]
                month = 0
                year = ""
                if _geo_month_num(parts[i + 1]):
                    month = _geo_month_num(parts[i + 1])
                    rest = parts[i + 2 :]
                elif _lat_month_num(parts[i + 1]):
                    month = _lat_month_num(parts[i + 1])
                    rest = parts[i + 2 :]
                else:
                    continue
                for p in rest[:3]:
                    if _lat_month_num(p) and not month:
                        month = _lat_month_num(p)
                    if re.fullmatch(r"\d{4}", p):
                        year = p
                        break
                if month and year:
                    return _normalize_display_date(day, str(month), year)
        return ""

    # Original text first (months stay as SEP/JUL), then digit-softened fallback
    return _try(text) or _try(_soft_date_ocr(text))


def _passport_find_dates(text: str) -> list[str]:
    """
    Prefer verbal-month passport dates (18 ივლ / JUL 2023).
    Numeric DD.MM.YYYY kept only as secondary fallback.
    """
    found: list[str] = []
    month_dt = _parse_passport_month_date(text or "")
    if month_dt:
        found.append(month_dt)

    soft = _soft_date_ocr(text or "")
    for src in (text or "", soft):
        md = _parse_passport_month_date(src)
        if md and md not in found:
            found.append(md)

    # Secondary: classic numeric (rarely used on passport issue line)
    for d in _find_dates_in_text(text or ""):
        if d not in found:
            found.append(d)
    return found


_PASSPORT_ISSUE_LABEL_RE = re.compile(
    r"გაცემის\s*თარ|გაცემ|"
    r"date\s*[o0]f\s*iss|"
    r"late\s*[o0]f\s*iss|"  # OCR: DATE → LATE
    r"dato\s*[o0]f\s*iss|"
    r"ati\s*se|"  # OCR: DATE OF ISSUE → ATI SE
    r"dateofiss|lateofiss|"
    r"date\s*of\s*issue|late\s*of\s*issue|"
    r"\bissue\b|\bissl|\blssue",
    re.IGNORECASE,
)

_PASSPORT_PLACE_LABEL_RE = re.compile(
    r"დაბადების\s*ადგილ|place\s*of\s*birth",
    re.IGNORECASE,
)


def _passport_exclude_set(exclude_dates: list[str]) -> set[str]:
    exclude: set[str] = set()
    for d in exclude_dates:
        if not d:
            continue
        m = re.search(r"(\d{1,2})[./\-](\d{1,2})[./\-](\d{4})", d)
        if m:
            nd = _normalize_display_date(m.group(1), m.group(2), m.group(3))
            if nd:
                exclude.add(nd)
    return exclude


def _passport_mrz_y_cutoff(words: list[dict]) -> float:
    """Y above which visual fields live; MRZ is the bottom strip — ignore it for issue date."""
    if not words:
        return 1e9
    max_y = max(w["y2"] for w in words)
    min_y = min(w["y1"] for w in words)
    # MRZ typically occupies bottom ~22–30% of passport data page
    return min_y + (max_y - min_y) * 0.78


def _passport_issue_date_from_words(words: list[dict], exclude: set[str]) -> str:
    """
    Visual-only: Date of Issue sits under Place of birth on the passport page
    (NOT in MRZ). Prefer label «გაცემის თარიღი / DATE OF ISSUE», else first
    non-birth/expiry date below place-of-birth.
    """
    if not words:
        return ""

    mrz_cut = _passport_mrz_y_cutoff(words)
    visual = [w for w in words if w["cy"] < mrz_cut]
    if not visual:
        visual = words

    def row_h(w: dict) -> float:
        return max(12.0, w["y2"] - w["y1"])

    def dates_near_anchor(anchor: dict, below_only: bool = False, max_rows: float = 6.0) -> list[tuple[float, str]]:
        rh = row_h(anchor)
        hits: list[tuple[float, str]] = []
        # Same row (to the right) + rows below — passport often puts value right of label
        y0 = anchor["cy"] - (0.45 * rh)
        band = [w for w in visual if w["cy"] >= y0 and w["cy"] <= anchor["cy"] + rh * max_rows]
        band.sort(key=lambda w: (round(w["cy"] / max(6, rh * 0.5)), w["cx"]))

        rows: list[list[dict]] = []
        for w in band:
            if not rows or abs(rows[-1][-1]["cy"] - w["cy"]) > rh * 0.55:
                rows.append([w])
            else:
                rows[-1].append(w)

        for ri, row in enumerate(rows):
            joined = " ".join(x["text"] for x in row)
            soft = " ".join(_soft_date_ocr(x["text"]) for x in row)
            for blob in (joined, soft, re.sub(r"\s+", "", soft), re.sub(r"\s+", "", _soft_date_ocr(joined))):
                for d in _passport_find_dates(blob):
                    if d in exclude:
                        continue
                    # Prefer same row to the right, then immediately below
                    same_row = abs(row[0]["cy"] - anchor["cy"]) < rh * 0.55
                    to_right = row[0]["cx"] >= anchor["cx"] - 20
                    dist = abs(row[0]["cy"] - anchor["cy"]) + 0.12 * abs(row[0]["cx"] - anchor["cx"])
                    if same_row and to_right:
                        dist -= 25
                    if below_only and same_row:
                        dist += 15
                    hits.append((dist + ri * 2, d))
        return hits

    # --- 1) Explicit issue-date label (incl. OCR «LATE OF ISSUE») ---
    issue_labels = []
    for w in visual:
        t = w["text"]
        tl = t.lower()
        if "გაცემ" in t or "თარიღ" in t:
            # Prefer გაცემის თარიღი row
            same = [x for x in visual if abs(x["cy"] - w["cy"]) < row_h(w) * 0.7]
            row_txt = " ".join(x["text"] for x in same)
            if "გაცემ" in row_txt or _PASSPORT_ISSUE_LABEL_RE.search(row_txt):
                issue_labels.append(w)
            continue
        if _PASSPORT_ISSUE_LABEL_RE.search(t) and "author" not in tl:
            issue_labels.append(w)
        if any(x in tl for x in ("issue", "issl", "issuc", "lssue", "late")) and "author" not in tl:
            # «LATE» alone only if OF/ISSUE nearby on row
            same = [x for x in visual if abs(x["cy"] - w["cy"]) < row_h(w) * 0.7]
            row_txt = " ".join(x["text"] for x in same).lower()
            if "issue" in row_txt or "issl" in row_txt or "გაცემ" in "".join(x["text"] for x in same):
                issue_labels.append(w)

    if issue_labels:
        anchor = max(issue_labels, key=lambda w: w["cy"])
        hits = dates_near_anchor(anchor, below_only=False, max_rows=6)
        if hits:
            hits.sort(key=lambda x: x[0])
            return hits[0][1]

    # --- 2) Below Place of birth ---
    place_labels = []
    for w in visual:
        t = w["text"]
        tl = t.lower()
        if "ადგილ" in t or ("place" in tl and "birth" in tl):
            place_labels.append(w)
        elif "დაბადების" in t:
            # Same-row «ადგილი» strengthens place-of-birth (not date of birth)
            same = [
                x for x in visual
                if abs(x["cy"] - w["cy"]) < row_h(w) * 0.8
            ]
            row_txt = " ".join(x["text"] for x in same)
            if "ადგილ" in row_txt or "place" in row_txt.lower():
                place_labels.append(w)
            elif "თარიღ" not in row_txt and "date" not in row_txt.lower():
                # standalone დაბადების near place context
                place_labels.append(w)

    if place_labels:
        # Top-most place label, then search downward for issue label or date
        place_anchor = min(place_labels, key=lambda w: w["cy"])
        rh = row_h(place_anchor)
        below = [w for w in visual if w["cy"] > place_anchor["cy"] + rh * 0.3]
        # First try issue label under place
        under_issue = [
            w for w in below
            if "გაცემ" in w["text"] or "issue" in w["text"].lower() or "issl" in w["text"].lower()
        ]
        if under_issue:
            anchor = min(under_issue, key=lambda w: w["cy"])
            hits = dates_near_anchor(anchor, below_only=True, max_rows=4)
            if hits:
                hits.sort(key=lambda x: x[0])
                return hits[0][1]

        # Else: dates under place-of-birth block (skip birth date itself)
        hits = dates_near_anchor(place_anchor, below_only=True, max_rows=10)
        hits = [(d, dt) for d, dt in hits if dt not in exclude]
        if hits:
            hits.sort(key=lambda x: x[0])
            return hits[0][1]

    return ""


def _passport_issue_date(
    lines: list[str],
    full_text: str,
    words: list[dict],
    exclude_dates: list[str],
) -> str:
    """
    Exact passport layout (under Place of birth):

      დაბადების ადგილი / PLACE OF BIRTH
      გარდაბანი / GARDABANI
      გაცემის თარიღი / DATE OF ISSUE
      18 ივლ / JUL 2023   ← this value → issue_date (DD.MM.YYYY)

    Never read from MRZ.
    """
    exclude = _passport_exclude_set(exclude_dates)

    clean_lines = [
        ln for ln in lines
        if ln.strip() and not re.search(r"P<[A-Z]|<{3,}|\bIDGEO\b", ln, re.I)
    ]

    def value_under_issue_label(label_idx: int) -> str:
        """
        Next line after DATE OF ISSUE = verbal month date (06 სექ / SEP 2018).
        Trust label-anchored values — do NOT drop them if they equal birth/expiry
        (common OCR collision: MRZ birth misread as issue day, or same-day issue).
        """
        for k in range(label_idx + 1, min(label_idx + 6, len(clean_lines))):
            nxt = clean_lines[k].strip()
            if not nxt:
                continue
            if _PASSPORT_PLACE_LABEL_RE.search(nxt) or re.search(
                r"authority|ორგანო|ირგანო|signature|ხელმოწერ|expiry|მოქმედების|"
                r"ministry|სამინისტრ|personal|პირადი",
                nxt,
                re.I,
            ):
                break
            if _PASSPORT_ISSUE_LABEL_RE.search(nxt) and not re.search(r"\d", nxt):
                continue
            md = _parse_passport_month_date(nxt)
            if md:
                return md
            glued = " ".join(clean_lines[k : min(k + 3, len(clean_lines))])
            md = _parse_passport_month_date(glued)
            if md:
                return md
            for d in _passport_find_dates(nxt) or _passport_find_dates(glued):
                return d
        same = clean_lines[label_idx]
        md = _parse_passport_month_date(same)
        if md:
            return md
        for d in _passport_find_dates(same):
            return d
        return ""

    # --- Primary: PLACE OF BIRTH → … → DATE OF ISSUE → value line ---
    for i, line in enumerate(clean_lines):
        if not _PASSPORT_PLACE_LABEL_RE.search(line):
            continue
        for j in range(i + 1, min(i + 12, len(clean_lines))):
            if _PASSPORT_ISSUE_LABEL_RE.search(clean_lines[j]):
                got = value_under_issue_label(j)
                if got:
                    return got
                break

    # --- Fallback: any DATE OF ISSUE / გაცემის თარიღი label ---
    for i, line in enumerate(clean_lines):
        if not _PASSPORT_ISSUE_LABEL_RE.search(line):
            continue
        got = value_under_issue_label(i)
        if got:
            return got

    # --- Scan any line that looks like «06 სექ / SEP 2018» near issue context ---
    for i, line in enumerate(clean_lines):
        md = _parse_passport_month_date(line)
        if not md:
            continue
        window = " ".join(clean_lines[max(0, i - 3) : i + 1])
        if re.search(r"გაცემ|issue|ati\s*se|თარიღ|late\s*of", window, re.I):
            return md
    # Any verbal-month date in visual block (passport has only one: issue)
    for line in clean_lines:
        md = _parse_passport_month_date(line)
        if md:
            return md

    # --- Word boxes (exclude only for ambiguous scavenges) ---
    from_words = _passport_issue_date_from_words(words or [], exclude)
    if from_words:
        return from_words

    md = _parse_passport_month_date(full_text)
    if md:
        return md
    return ""


def _fix_passport_number(raw: str) -> str:
    """Passport MRZ document number is 9 chars; GEO often DDLLDDDDD."""
    cleaned = re.sub(r"[^A-Z0-9]", "", (raw or "").upper())
    if len(cleaned) >= 9:
        cleaned = cleaned[:9]
    if len(cleaned) == 9:
        fixed = _fix_georgian_card_number(cleaned)
        if re.fullmatch(r"\d{2}[A-Z]{2}\d{5}", fixed):
            return fixed
    # Generic OCR digit/letter noise for other formats
    return cleaned.replace("O", "0") if cleaned[:2].isdigit() else cleaned


# MRZ digits often OCR as letters (O/D/Q→0, I/L→1, Z→2, S→5, B→8, G→6)
_MRZ_D = r"[0-9ODQILZSBG]"
_TD3_LINE2_RE = re.compile(
    rf"(?P<doc>[A-Z0-9]{{9}}){_MRZ_D}"
    rf"(?P<nat>[A-Z]{{3}})"
    rf"(?P<birth>{_MRZ_D}{{6}}){_MRZ_D}"
    rf"(?P<sex>[MF<])"
    rf"(?P<exp>{_MRZ_D}{{6}})"
)


def extract_passport_mrz_strip(text: str) -> str:
    """
    TD3 passport MRZ: 2 lines × 44 chars.
    Example:
      P<GEOMURUSIDZE<<DAVIT<<<<<<<<<<<<<<<<<<<<<<<
      18AB123456GEO0601120M270313201234567890<<<94
    """
    if not text:
        return ""

    lines = [_normalize_mrz_line(l) for l in text.splitlines() if l.strip()]
    blob = _normalize_mrz_line(text.replace("\n", " "))
    blob = (
        blob.replace("P0GEO", "P<GEO")
        .replace("POGEO", "P<GEO")
        .replace("P<GE0", "P<GEO")
        .replace("P<GFO", "P<GEO")
    )

    line1 = ""
    line2 = ""

    for l in lines:
        c = (
            l.replace("P0GEO", "P<GEO")
            .replace("POGEO", "P<GEO")
            .replace("P<GE0", "P<GEO")
            .replace("P<GFO", "P<GEO")
        )
        if c.startswith("PGEO"):
            c = "P<" + c[1:]
        if c.startswith("P<") or re.match(r"^P[O0]<", c):
            if not c.startswith("P<"):
                c = "P<" + c[2:]
            line1 = _fix_mrz_line(c, 44)
            break

    if not line1:
        m = re.search(r"(P<[A-Z0-9]{3}[A-Z0-9<]+)", blob)
        if m:
            line1 = _fix_mrz_line(m.group(1), 44)

    # Leading «P<» itself misread: rebuild from the name row (SURNAME<<GIVEN<<<…)
    if not line1:
        for l in lines:
            if "<<" not in l or len(l) < 20 or not re.fullmatch(r"[A-Z0-9<]+", l):
                continue
            if _TD3_LINE2_RE.search(l):
                continue
            m = re.match(r"^[A-Z0-9<]{0,3}GE[O0](?P<rest>[A-Z<]{4,})$", l)
            if not m:
                m = re.match(r"^[A-Z0-9<]{0,6}?(?P<rest>[A-Z]{2,}<<[A-Z<]+)$", l)
            if m:
                line1 = _fix_mrz_line("P<GEO" + m.group("rest"), 44)
                break

    for src in lines + [blob]:
        if src.startswith("P<") or "<<" in src[:20]:
            continue
        m = _TD3_LINE2_RE.search(src)
        if m:
            line2 = _fix_mrz_line(src[m.start() :], 44)
            break

    # OCR sometimes glues both MRZ rows into one line starting with P<
    if line1 and not line2:
        for src in lines + [blob]:
            m = _TD3_LINE2_RE.search(src)
            if m:
                line2 = _fix_mrz_line(src[m.start() :], 44)
                break

    if line1 and not line2:
        start = blob.find(line1[:12]) if len(line1) >= 12 else blob.find("P<")
        if start >= 0:
            chunk = re.sub(r"[^A-Z0-9<]", "", blob[start:])
            if len(chunk) >= 88:
                line1 = _fix_mrz_line(chunk[:44], 44)
                line2 = _fix_mrz_line(chunk[44:88], 44)
            elif len(chunk) >= 44 and not line1:
                line1 = _fix_mrz_line(chunk[:44], 44)

    parts = [p for p in (line1, line2) if p]
    return "\n".join(parts) if parts else ""


def has_passport_mrz(strip: str) -> bool:
    """A TD3 strip is usable when it has both rows, the P< row, or the data row."""
    if not strip:
        return False
    return (
        "\n" in strip
        or strip.startswith("P<")
        or bool(_TD3_LINE2_RE.search(strip))
    )


def _mrz_yymmdd(raw: str, century_split: bool) -> str:
    """
    MRZ YYMMDD → DD.MM.YYYY, tolerating OCR letter/digit swaps (O→0, I→1, S→5…).
    century_split=True for birth dates (>30 ⇒ 19xx), False for expiry (always 20xx).
    """
    digits = _mrz_personal_from_raw(raw)  # shared OCR digit mapping
    if len(digits) < 6:
        return ""
    d = digits[:6]
    yy, mm, dd = d[0:2], d[2:4], d[4:6]
    if not (1 <= int(mm) <= 12) or not (1 <= int(dd) <= 31):
        return ""
    if century_split:
        year = ("19" if int(yy) > 30 else "20") + yy
    else:
        year = "20" + yy
    return f"{dd}.{mm}.{year}"


def parse_passport_mrz(text: str, lines: list[str] | None = None) -> dict:
    """Parse TD3 passport MRZ into fields (card_number = passport number)."""
    mrz: dict = {}
    strip = extract_passport_mrz_strip(text)
    strip_lines = strip.splitlines() if strip else []

    line1 = strip_lines[0] if len(strip_lines) >= 1 else ""
    line2 = strip_lines[1] if len(strip_lines) >= 2 else ""

    if line1.startswith("P") and len(line1) >= 5:
        rest = line1[2:] if line1.startswith("P<") else line1[1:]
        if len(rest) >= 3:
            nat = rest[:3].replace("0", "O")
            if re.fullmatch(r"[A-Z]{3}", nat):
                mrz["citizenship_code"] = "GEO" if nat == "GFO" else nat
            name_part = rest[3:]
            if "<<" in name_part:
                last, first = name_part.split("<<", 1)
                last = re.sub(r"[^A-Z]", "", last.replace("<", ""))
                first = re.sub(r"[^A-Z ]", "", first.replace("<", " ")).strip()
                if last:
                    mrz["_mrz_last_name"] = last
                if first:
                    mrz["_mrz_first_name"] = first

    if len(line2) >= 28:
        mrz["card_number"] = _fix_passport_number(line2[0:9])
        nat = line2[10:13].replace("0", "O")
        if re.fullmatch(r"[A-Z]{3}", nat):
            mrz["citizenship_code"] = "GEO" if nat == "GFO" else nat
        b_raw = line2[13:19]
        sex = line2[20:21]
        e_raw = line2[21:27]
        birth = _mrz_yymmdd(b_raw, True)
        if birth:
            mrz["birth_date"] = birth
        if sex == "M":
            mrz["gender"] = "მმ / M"
        elif sex == "F":
            mrz["gender"] = "მდ / F"
        expiry = _mrz_yymmdd(e_raw, False)
        if expiry:
            mrz["expiry_date"] = expiry
        # Personal number is NOT in Georgian passport MRZ — do not read optional field

    if not mrz.get("card_number") or not mrz.get("birth_date") or not mrz.get("expiry_date"):
        blob = _normalize_mrz_line((text or "").replace("\n", " "))
        m = _TD3_LINE2_RE.search(blob)
        if m:
            if not mrz.get("card_number"):
                mrz["card_number"] = _fix_passport_number(m.group("doc"))
            nat = m.group("nat").replace("0", "O")
            if re.fullmatch(r"[A-Z]{3}", nat):
                mrz["citizenship_code"] = "GEO" if nat == "GFO" else nat
            if not mrz.get("birth_date"):
                birth = _mrz_yymmdd(m.group("birth"), True)
                if birth:
                    mrz["birth_date"] = birth
            if not mrz.get("gender"):
                sex = m.group("sex")
                if sex == "M":
                    mrz["gender"] = "მმ / M"
                elif sex == "F":
                    mrz["gender"] = "მდ / F"
            if not mrz.get("expiry_date"):
                expiry = _mrz_yymmdd(m.group("exp"), False)
                if expiry:
                    mrz["expiry_date"] = expiry

    if not mrz.get("_mrz_last_name"):
        blob = _normalize_mrz_line((text or "").replace("\n", " "))
        m = re.search(r"P<[A-Z0-9]{3}([A-Z]+)<<([A-Z<]+)", blob)
        if m:
            mrz["_mrz_last_name"] = m.group(1)
            mrz["_mrz_first_name"] = m.group(2).replace("<", " ").strip()

    return mrz


def extract_passport_info(image_bytes: bytes) -> dict:
    """OCR + TD3 MRZ extraction from a single passport data-page photo."""
    full_text, lines, words, rotation = ocr_image_ex(image_bytes)

    mrz = parse_passport_mrz(full_text, lines)
    mrz_strip = extract_passport_mrz_strip(full_text)

    data = {
        k: v
        for k, v in mrz.items()
        if k in ("birth_date", "expiry_date", "gender", "citizenship")
    }
    mrz_pid = ""  # not present in passport MRZ
    mrz_doc = mrz.get("card_number", "")

    data = _parse_visual_fields(full_text, lines, data)

    if mrz_doc and len(re.sub(r"[^A-Z0-9]", "", mrz_doc.upper())) >= 8:
        data["card_number"] = _fix_passport_number(mrz_doc)
    else:
        ids = _ids_near_labels(lines, full_text)
        passport_doc = _value_after_labels(
            lines,
            [
                "პასპორტის ნომერი", "პასპორტის №", "პასპორტის #",
                "passport no", "passport number", "passport №", "pasport no",
            ],
        )
        data["card_number"] = _fix_passport_number(
            passport_doc or ids.get("card_number") or data.get("card_number") or ""
        )

    # Personal number: visual OCR only (MRZ does not contain it)
    ids = _ids_near_labels(lines, full_text)
    layout_pid = _personal_id_from_layout(words)
    data["personal_id"] = (
        layout_pid
        or ids.get("personal_id")
        or _pick_personal_id(_find_personal_ids(full_text))
        or ""
    )

    latin_hints = {
        "_mrz_last_name": mrz.get("_mrz_last_name", ""),
        "_mrz_first_name": mrz.get("_mrz_first_name", ""),
    }
    # Passport-specific names (do not use ID card name heuristic — picks «ქვეყნის კოდი»)
    geo_names = _passport_georgian_names(
        lines,
        latin_hints["_mrz_first_name"],
        latin_hints["_mrz_last_name"],
    )
    data["first_name"] = geo_names.get("first_name", "")
    data["last_name"] = geo_names.get("last_name", "")

    place = _birth_place_from_back(lines)
    if place and not _is_passport_name_junk(place):
        data["birth_place"] = place
    elif data.get("birth_place") and not _is_passport_name_junk(data["birth_place"]):
        data["birth_place"] = _georgian_only(data["birth_place"]) or data["birth_place"]
    else:
        data["birth_place"] = _georgian_only(data.get("birth_place", "")) or ""

    data["issue_date"] = _passport_issue_date(
        lines,
        full_text,
        words,
        exclude_dates=[
            data.get("birth_date", ""),
            data.get("expiry_date", ""),
            mrz.get("birth_date", ""),
            mrz.get("expiry_date", ""),
        ],
    )
    if not data["issue_date"]:
        sniff = []
        for i, ln in enumerate(lines):
            if re.search(
                r"გაცემ|late\s*of\s*iss|date\s*of\s*iss|ati\s*se|ადგილ|place\s*of\s*birth|"
                r"\d{1,2}\s*[\u10D0-\u10FF]{2,8}\s*/\s*[A-Za-z]{3}",
                ln,
                re.I,
            ):
                sniff.extend(lines[i : i + 5])
        seen: set[str] = set()
        uniq = []
        for ln in sniff:
            if ln not in seen:
                seen.add(ln)
                uniq.append(ln)
        print(
            "Passport issue date MISSING. exclude:",
            [data.get("birth_date"), data.get("expiry_date")],
            "| sniff:",
            ascii(" | ".join(uniq[:16])),
        )

    first_geo, first_lat = _split_pair(
        data.get("first_name", ""), mrz.get("_mrz_first_name", "")
    )
    last_geo, last_lat = _split_pair(
        data.get("last_name", ""), mrz.get("_mrz_last_name", "")
    )
    # Drop junk geo if split somehow kept a label
    if _is_passport_name_junk(first_geo):
        first_geo = ""
    if _is_passport_name_junk(last_geo):
        last_geo = ""
    # Final letter repair against MRZ Latin
    if first_geo:
        first_geo = _fix_passport_geo_name(first_geo, mrz.get("_mrz_first_name", ""))
    if last_geo:
        last_geo = _fix_passport_geo_name(last_geo, mrz.get("_mrz_last_name", ""))
    # MRZ Latin names always fill the Latin fields even when Georgian OCR is empty
    first_lat = (first_lat or mrz.get("_mrz_first_name", "") or "").strip()
    last_lat = (last_lat or mrz.get("_mrz_last_name", "") or "").strip()
    raw_place = (data.get("birth_place") or "").strip()
    place_geo = _georgian_only(raw_place) or ""
    if place_geo and _is_place_junk(place_geo):
        place_geo = ""
    if _is_passport_name_junk(place_geo):
        place_geo = ""
    place_lat = _birth_place_latin_from_back(lines, place_geo)
    # Always repair: empty/junk Georgian can still be recovered from known Latin
    place_geo = _repair_place_geo(place_geo, place_lat)
    place_geo, place_lat = _split_pair(place_geo, place_lat)
    place_lat = _clean_place_latin(place_geo, place_lat)

    data["first_name"] = first_geo
    data["first_name_lat"] = first_lat
    data["last_name"] = last_geo
    data["last_name_lat"] = last_lat
    data["birth_place"] = place_geo
    data["birth_place_lat"] = place_lat
    data["citizenship"] = _format_citizenship(
        mrz.get("citizenship_code") or data.get("citizenship", "")
    ) or (mrz.get("citizenship_code") or "GEO")

    if mrz.get("gender"):
        data["gender"] = _format_gender_display(mrz["gender"])
    elif data.get("gender"):
        data["gender"] = _format_gender_display(
            _parse_gender(data["gender"]) or data["gender"]
        )
    else:
        data["gender"] = ""

    if mrz.get("birth_date"):
        data["birth_date"] = mrz["birth_date"]
    if mrz.get("expiry_date"):
        data["expiry_date"] = mrz["expiry_date"]
    if mrz.get("gender"):
        data["gender"] = _format_gender_display(mrz["gender"])

    data["card_number"] = _fix_passport_number(data.get("card_number", ""))
    if mrz.get("card_number"):
        mrz["card_number"] = _fix_passport_number(mrz["card_number"])

    verify_data = dict(data)
    if data.get("first_name") or data.get("first_name_lat"):
        verify_data["first_name"] = _format_bilingual(
            data.get("first_name", ""), data.get("first_name_lat", "")
        )
    if data.get("last_name") or data.get("last_name_lat"):
        verify_data["last_name"] = _format_bilingual(
            data.get("last_name", ""), data.get("last_name_lat", "")
        )

    verification = verify_against_passport_mrz(verify_data, mrz)

    return {
        "extracted_data": {
            "first_name": data.get("first_name", ""),
            "first_name_lat": data.get("first_name_lat", ""),
            "last_name": data.get("last_name", ""),
            "last_name_lat": data.get("last_name_lat", ""),
            "birth_date": data.get("birth_date", ""),
            "birth_place": data.get("birth_place", ""),
            "birth_place_lat": data.get("birth_place_lat", ""),
            "citizenship": data.get("citizenship", "") or "GEO",
            "gender": data.get("gender", ""),
            "personal_id": data.get("personal_id", ""),
            "expiry_date": data.get("expiry_date", ""),
            "card_number": data.get("card_number", ""),
            "issue_date": data.get("issue_date", ""),
            "mrz_strip": mrz_strip,
            "document_type": "passport",
        },
        "mrz_fields": {
            "personal_id": "",  # not in passport MRZ
            "card_number": mrz.get("card_number", ""),
            "birth_date": mrz.get("birth_date", ""),
            "expiry_date": mrz.get("expiry_date", ""),
            "gender": mrz.get("gender", ""),
            "first_name": mrz.get("_mrz_first_name", ""),
            "last_name": mrz.get("_mrz_last_name", ""),
            "citizenship": mrz.get("citizenship_code", ""),
        },
        "verification": verification,
        "is_valid": verification["status"] == "Checked",
        # Counter-clockwise degrees the UI must apply to show the photo upright
        "orientation": {"passport": rotation},
        "raw_text": {
            "passport": full_text,
        },
    }


def verify_against_passport_mrz(data: dict, mrz: dict) -> dict:
    """Passport-only MRZ check — does not alter ID verify_against_mrz."""
    mismatches = []
    checks = {}

    def add(field: str, ok: bool, expected: str = "", actual: str = ""):
        checks[field] = {"ok": ok, "expected": expected, "actual": actual}
        if not ok:
            mismatches.append(field)

    has_core = bool(mrz.get("card_number") and mrz.get("birth_date"))
    if not has_core:
        return {
            "status": "Error",
            "mismatches": ["mrz"],
            "checks": {},
            "message": "პასპორტის MRZ ვერ ამოიკითხა",
        }

    # personal_id: Uncheckable — not in passport MRZ
    if mrz.get("card_number"):
        a = re.sub(r"[^A-Z0-9]", "", (data.get("card_number") or "").upper())
        e = mrz["card_number"]
        add("card_number", a == e, e, a)
    if mrz.get("birth_date"):
        a = _norm_cmp(data.get("birth_date", ""))
        e = _norm_cmp(mrz["birth_date"])
        add("birth_date", a == e, mrz["birth_date"], data.get("birth_date", ""))
    if mrz.get("expiry_date"):
        a = _norm_cmp(data.get("expiry_date", ""))
        e = _norm_cmp(mrz["expiry_date"])
        add("expiry_date", a == e, mrz["expiry_date"], data.get("expiry_date", ""))
    if mrz.get("gender"):
        a = _gender_letter(data.get("gender", ""))
        e = _gender_letter(mrz["gender"])
        add("gender", bool(a and e and a == e), mrz["gender"], data.get("gender", ""))

    if mrz.get("_mrz_first_name"):
        latin = _latin_from_bilingual(data.get("first_name", ""))
        e = mrz["_mrz_first_name"].replace(" ", "")
        a = latin.replace(" ", "")
        if a:
            add("first_name", a == e or e.startswith(a) or a.startswith(e), mrz["_mrz_first_name"], latin)
        elif data.get("first_name"):
            add("first_name", True, mrz["_mrz_first_name"], data.get("first_name", ""))

    if mrz.get("_mrz_last_name"):
        latin = _latin_from_bilingual(data.get("last_name", ""))
        e = mrz["_mrz_last_name"].replace(" ", "")
        a = latin.replace(" ", "")
        if a:
            add("last_name", a == e or e.startswith(a) or a.startswith(e), mrz["_mrz_last_name"], latin)
        elif data.get("last_name"):
            add("last_name", True, mrz["_mrz_last_name"], data.get("last_name", ""))

    if mrz.get("citizenship_code"):
        expected = re.sub(r"[^A-Z]", "", mrz["citizenship_code"].upper())[:3]
        actual = _format_citizenship(data.get("citizenship", "")) or re.sub(
            r"[^A-Z]", "", (data.get("citizenship") or "").upper()
        )[:3]
        ok = bool(expected and actual and expected == actual)
        add("citizenship", ok, expected, data.get("citizenship", ""))

    return {
        "status": "Checked" if not mismatches else "Error",
        "mismatches": mismatches,
        "checks": checks,
    }
