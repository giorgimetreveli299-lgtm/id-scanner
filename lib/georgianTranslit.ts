/** National / passport-style Georgian ↔ Latin for person names on IDs. */

const KA_TO_LAT: Record<string, string> = {
  ა: "a",
  ბ: "b",
  გ: "g",
  დ: "d",
  ე: "e",
  ვ: "v",
  ზ: "z",
  თ: "t",
  ი: "i",
  კ: "k",
  ლ: "l",
  მ: "m",
  ნ: "n",
  ო: "o",
  პ: "p",
  ჟ: "zh",
  რ: "r",
  ს: "s",
  ტ: "t",
  უ: "u",
  ფ: "ph",
  ქ: "k",
  ღ: "gh",
  ყ: "q",
  შ: "sh",
  ჩ: "ch",
  ც: "ts",
  ძ: "dz",
  წ: "ts",
  ჭ: "tch",
  ხ: "kh",
  ჯ: "j",
  ჰ: "h",
};

const GEO_RE = /[\u10A0-\u10FF]/;
const LATIN_RE = /[A-Za-z]/;

function titleLatin(value: string): string {
  const s = value.trim();
  if (!s) return "";
  return s
    .toLowerCase()
    .split(/([\s\-']+)/)
    .map((part) => {
      if (!/[a-z]/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("");
}

function latinNorm(value: string): string {
  return (value || "").toUpperCase().replace(/[^A-Z]/g, "");
}

/** Georgian → Latin (national / passport style used on Georgian IDs). */
export function transliterateKa(geo: string): string {
  if (!geo) return "";
  let out = "";
  for (const ch of geo) {
    if (KA_TO_LAT[ch]) out += KA_TO_LAT[ch];
    else if (ch === " " || ch === "-" || ch === "'") out += ch;
  }
  return titleLatin(out);
}

/**
 * Latin → Georgian (best-effort reverse). Digraphs first.
 * Ambiguous letters use common personal-name forms (თ/კ/პ/ჩ/ც).
 */
export function latinToGeorgianApprox(latin: string): string {
  const s = latinNorm(latin);
  if (!s) return "";

  // Longest digraphs first
  const mapping: [string, string][] = [
    ["TCH", "ჭ"],
    ["ZH", "ჟ"],
    ["GH", "ღ"],
    ["SH", "შ"],
    ["CH", "ჩ"],
    ["TS", "ც"],
    ["DZ", "ძ"],
    ["KH", "ხ"],
    ["PH", "ფ"],
    ["A", "ა"],
    ["B", "ბ"],
    ["G", "გ"],
    ["D", "დ"],
    ["E", "ე"],
    ["V", "ვ"],
    ["Z", "ზ"],
    ["T", "თ"],
    ["I", "ი"],
    ["K", "კ"],
    ["L", "ლ"],
    ["M", "მ"],
    ["N", "ნ"],
    ["O", "ო"],
    ["P", "პ"],
    ["R", "რ"],
    ["S", "ს"],
    ["U", "უ"],
    ["Q", "ყ"],
    ["J", "ჯ"],
    ["H", "ჰ"],
    ["F", "ფ"],
    ["W", "ვ"],
    ["Y", "ი"],
    ["X", "ქ"],
  ];

  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let matched = false;
    for (const [lat, geo] of mapping) {
      if (s.startsWith(lat, i)) {
        out.push(geo);
        i += lat.length;
        matched = true;
        break;
      }
    }
    if (!matched) i += 1;
  }
  let geo = out.join("");
  // ID cards often keep Latin without final -i while Georgian ends with ი
  // (e.g. Garibov → გარიბოვი). Append ი when Latin ends on a consonant.
  if (geo && !geo.endsWith("ი") && !/[AEIOUY]$/.test(s)) {
    geo += "ი";
  }
  return geo;
}

function georgianOnly(value: string): string {
  return (value.match(/[\u10A0-\u10FF\s\-']+/g) || []).join("").trim();
}

function latinOnly(value: string): string {
  return (value.match(/[A-Za-z\s\-']+/g) || []).join("").trim();
}

/**
 * Always return `ქართული / Latin` for a name field.
 * Accepts Georgian-only, Latin-only, or already bilingual input.
 */
export function formatBilingualName(value: string | null | undefined): string | null {
  if (!value) return null;
  let raw = value.trim();
  if (!raw) return null;

  let geo = "";
  let latin = "";

  if (raw.includes("/")) {
    const [left, right] = raw.split("/", 2).map((p) => p.trim());
    geo = georgianOnly(left) || (GEO_RE.test(left) ? left : "");
    latin = latinOnly(right || "") || (LATIN_RE.test(right || "") ? right : "");
    if (!geo && LATIN_RE.test(left) && !GEO_RE.test(left)) {
      latin = latinOnly(left) || left;
    }
    if (!latin && GEO_RE.test(right || "")) {
      geo = georgianOnly(right) || right;
    }
  } else if (GEO_RE.test(raw) && !LATIN_RE.test(raw)) {
    geo = georgianOnly(raw) || raw;
  } else if (LATIN_RE.test(raw) && !GEO_RE.test(raw)) {
    latin = latinOnly(raw) || raw;
  } else if (GEO_RE.test(raw) && LATIN_RE.test(raw)) {
    // Mixed without slash — prefer Georgian chars as geo side
    geo = georgianOnly(raw);
    latin = latinOnly(raw);
  } else {
    return raw;
  }

  if (geo && !latin) latin = transliterateKa(geo);
  if (latin && !geo) geo = latinToGeorgianApprox(latin);

  latin = titleLatin(latin);
  geo = geo.trim();
  latin = latin.trim();

  if (geo && latin) return `${geo} / ${latin}`;
  return geo || latin || null;
}

/** Common place names (Latin key → official Georgian). */
const KNOWN_PLACE_BY_LATIN: Record<string, string> = (() => {
  const places = [
    "თბილისი",
    "ბათუმი",
    "ქუთაისი",
    "რუსთავი",
    "ზუგდიდი",
    "გორი",
    "ფოთი",
    "თელავი",
    "ახალციხე",
    "ოზურგეთი",
    "სენაკი",
    "ზესტაფონი",
    "მარნეული",
    "გარდაბანი",
    "მცხეთა",
    "ქობულეთი",
    "ხაშური",
    "სამტრედია",
    "ბორჯომი",
    "გურჯაანი",
    "საქართველო",
  ];
  const map: Record<string, string> = {
    TBILISI: "თბილისი",
    BATUMI: "ბათუმი",
    KUTAISI: "ქუთაისი",
    RUSTAVI: "რუსთავი",
    ZUGDIDI: "ზუგდიდი",
    GORI: "გორი",
    POTI: "ფოთი",
    TELAVI: "თელავი",
    AKHALTSIKHE: "ახალციხე",
    OZURGETI: "ოზურგეთი",
    SENAKI: "სენაკი",
    ZESTAPHONI: "ზესტაფონი",
    ZESTAFONI: "ზესტაფონი",
    MARNEULI: "მარნეული",
    GARDABANI: "გარდაბანი",
    MTSKHETA: "მცხეთა",
    KOBULETI: "ქობულეთი",
    KHASHURI: "ხაშური",
    SAMTREDIA: "სამტრედია",
    BORJOMI: "ბორჯომი",
    GURJAANI: "გურჯაანი",
    GEORGIA: "საქართველო",
  };
  for (const p of places) {
    map[latinNorm(transliterateKa(p))] = p;
  }
  return map;
})();

function knownPlaceFromLatin(latin: string): string {
  const n = latinNorm(latin);
  if (!n) return "";
  if (KNOWN_PLACE_BY_LATIN[n]) return KNOWN_PLACE_BY_LATIN[n];
  // Match a known city inside a longer address string
  for (const [key, geo] of Object.entries(KNOWN_PLACE_BY_LATIN)) {
    if (key.length >= 4 && n.includes(key)) return geo;
  }
  return "";
}

/**
 * Place fields (birth / residence): always bilingual, prefer known city spellings.
 */
export function formatBilingualPlace(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const junk =
    /^(საცხოვრებელი\s*ადგილი|დაბადების\s*ადგილი|place\s*of\s*(residence|birth)|address|permanent\s*address)$/i;
  let raw = value.trim();
  if (!raw || junk.test(raw)) return null;

  raw = raw
    .replace(/^(საცხოვრებელი\s*ადგილი|დაბადების\s*ადგილი|place\s*of\s*(residence|birth)|address)\s*[:：]?\s*/i, "")
    .trim();
  if (!raw) return null;

  const formatted = formatBilingualName(raw);
  if (!formatted) return null;

  const parts = splitBilingualName(formatted);
  let { geo, latin } = parts;

  if (latin) {
    const known = knownPlaceFromLatin(latin);
    if (known) geo = known;
  }
  if (!geo && latin) geo = latinToGeorgianApprox(latin);
  if (!latin && geo) latin = transliterateKa(geo);

  return joinBilingualName(geo, latin) || null;
}

/**
 * Field 8 residence on Georgian DLs is always:
 * `საქართველო. ქალაქი / Georgia. City`
 */
export function formatResidence(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const junk =
    /^(საცხოვრებელი\s*ადგილი|place\s*of\s*residence|address|permanent\s*address)$/i;
  let raw = value.trim();
  if (!raw || junk.test(raw)) return null;

  raw = raw
    .replace(
      /^(საცხოვრებელი\s*ადგილი|მისამართი|place\s*of\s*residence|address)\s*[:：]?\s*/i,
      ""
    )
    .trim();
  if (!raw) return null;

  // Split bilingual or single-script first
  let { geo, latin } = splitBilingualName(raw);

  // Strip country tokens so we keep the city only
  const stripGeoCountry = (s: string) =>
    s
      .replace(/^საქართველო\.?\s*/i, "")
      .replace(/\s*საქართველო\.?\s*/gi, " ")
      .replace(/^[.\-\s]+/, "")
      .replace(/\s+/g, " ")
      .trim();
  const stripLatCountry = (s: string) =>
    s
      .replace(/^Georgia\.?\s*/i, "")
      .replace(/\bGeorgia\b\.?/gi, " ")
      .replace(/^[.\-\s]+/, "")
      .replace(/\s+/g, " ")
      .trim();

  geo = stripGeoCountry(geo);
  latin = stripLatCountry(latin);

  // If everything was in one side (e.g. "Georgia Rustavi")
  if (!geo && latin) {
    const known = knownPlaceFromLatin(latin);
    geo = known || latinToGeorgianApprox(latin);
    if (known) {
      // Prefer clean Latin city spelling from known map key match
      const n = latinNorm(latin);
      for (const [key, g] of Object.entries(KNOWN_PLACE_BY_LATIN)) {
        if (g === known && (n === key || n.includes(key))) {
          latin = titleLatin(key.toLowerCase());
          break;
        }
      }
    }
  }
  if (!latin && geo) {
    const knownLat = Object.entries(KNOWN_PLACE_BY_LATIN).find(
      ([, g]) => g === geo
    );
    latin = knownLat
      ? titleLatin(knownLat[0].toLowerCase())
      : transliterateKa(geo);
  }

  // Resolve known city spelling when both sides exist but geo is only city fragment
  if (latin) {
    const known = knownPlaceFromLatin(latin);
    if (known) geo = known;
  }

  geo = stripGeoCountry(geo);
  latin = stripLatCountry(titleLatin(latin));

  if (!geo && !latin) return null;

  const geoOut = geo ? `საქართველო. ${geo}` : "საქართველო";
  const latOut = latin ? `Georgia. ${latin}` : "Georgia";
  return `${geoOut} / ${latOut}`;
}

/** Split stored `ქართული / Latin` (or single-script) into two sides for UI. */
export function splitBilingualName(
  value: string | null | undefined
): { geo: string; latin: string } {
  const raw = (value || "").trim();
  if (!raw) return { geo: "", latin: "" };

  if (raw.includes("/")) {
    const [left, right] = raw.split("/", 2).map((p) => p.trim());
    let geo = georgianOnly(left);
    let latin = latinOnly(right || "");
    if (!geo && !LATIN_RE.test(left) && left) geo = left;
    if (!latin && LATIN_RE.test(right || "")) latin = right;
    if (!geo && LATIN_RE.test(left) && !GEO_RE.test(left)) {
      latin = latin || latinOnly(left) || left;
    }
    return { geo, latin };
  }

  if (GEO_RE.test(raw) && !LATIN_RE.test(raw)) {
    return { geo: georgianOnly(raw) || raw, latin: "" };
  }
  if (LATIN_RE.test(raw) && !GEO_RE.test(raw)) {
    return { geo: "", latin: latinOnly(raw) || raw };
  }
  return { geo: georgianOnly(raw), latin: latinOnly(raw) };
}

export function joinBilingualName(geo: string, latin: string): string {
  const g = geo.trim();
  const l = latin.trim();
  if (g && l) return `${g} / ${l}`;
  return g || l;
}
