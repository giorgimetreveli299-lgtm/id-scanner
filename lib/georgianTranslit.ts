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
  return (value.match(/[\u10A0-\u10FF\s\-',.]+/g) || []).join("").trim();
}

function latinOnly(value: string): string {
  return (value.match(/[A-Za-z\s\-',.]+/g) || []).join("").trim();
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

/**
 * Canonical Georgian cities / municipalities (not the country name).
 * `latin` is the spelling printed on IDs; `aliases` cover OCR / older forms.
 */
const CANONICAL_PLACES: { geo: string; latin: string; aliases?: string[] }[] = [
  { geo: "თბილისი", latin: "Tbilisi", aliases: ["Tiflis"] },
  { geo: "ბათუმი", latin: "Batumi" },
  { geo: "ქუთაისი", latin: "Kutaisi", aliases: ["Qutaisi"] },
  { geo: "რუსთავი", latin: "Rustavi" },
  { geo: "ზუგდიდი", latin: "Zugdidi" },
  { geo: "გორი", latin: "Gori" },
  { geo: "ფოთი", latin: "Poti" },
  { geo: "თელავი", latin: "Telavi" },
  { geo: "ახალციხე", latin: "Akhaltsikhe" },
  { geo: "ოზურგეთი", latin: "Ozurgeti" },
  { geo: "სენაკი", latin: "Senaki" },
  { geo: "ზესტაფონი", latin: "Zestafoni", aliases: ["Zestaphoni"] },
  { geo: "მარნეული", latin: "Marneuli" },
  { geo: "გარდაბანი", latin: "Gardabani" },
  { geo: "მცხეთა", latin: "Mtskheta" },
  { geo: "ქობულეთი", latin: "Kobuleti" },
  { geo: "ხაშური", latin: "Khashuri", aliases: ["Hasuri"] },
  { geo: "სამტრედია", latin: "Samtredia" },
  { geo: "ბორჯომი", latin: "Borjomi" },
  { geo: "გურჯაანი", latin: "Gurjaani" },
  { geo: "ხონი", latin: "Khoni" },
  { geo: "საჩხერე", latin: "Sachkhere" },
  { geo: "ჭიათურა", latin: "Chiatura", aliases: ["Tchiatura"] },
  { geo: "ტყიბული", latin: "Tkibuli" },
  { geo: "წყალტუბო", latin: "Tskaltubo", aliases: ["Tsqaltubo"] },
  { geo: "ლანჩხუთი", latin: "Lanchkhuti" },
  { geo: "ჩოხატაური", latin: "Chokhatauri" },
  { geo: "აბაშა", latin: "Abasha" },
  { geo: "მარტვილი", latin: "Martvili" },
  { geo: "წალენჯიხა", latin: "Tsalenjikha" },
  { geo: "ხობი", latin: "Khobi" },
  { geo: "მესტია", latin: "Mestia" },
  { geo: "ამბროლაური", latin: "Ambrolauri" },
  { geo: "ონი", latin: "Oni" },
  { geo: "ცაგერი", latin: "Tsageri" },
  { geo: "ლენტეხი", latin: "Lentekhi" },
  { geo: "ახალქალაქი", latin: "Akhalkalaki" },
  { geo: "ასპინძა", latin: "Aspindza" },
  { geo: "ნინოწმინდა", latin: "Ninotsminda" },
  { geo: "წალკა", latin: "Tsalka" },
  { geo: "თეთრიწყარო", latin: "Tetritskaro", aliases: ["Tetri Tskaro"] },
  { geo: "ბოლნისი", latin: "Bolnisi" },
  { geo: "დმანისი", latin: "Dmanisi" },
  { geo: "კასპი", latin: "Kaspi" },
  { geo: "ქარელი", latin: "Kareli" },
  { geo: "ხარაგაული", latin: "Kharagauli" },
  { geo: "საგარეჯო", latin: "Sagarejo" },
  { geo: "სიღნაღი", latin: "Signagi", aliases: ["Sighnaghi"] },
  { geo: "დედოფლისწყარო", latin: "Dedoplistskaro" },
  { geo: "ლაგოდეხი", latin: "Lagodekhi" },
  { geo: "ყვარელი", latin: "Kvareli" },
  { geo: "ახმეტა", latin: "Akhmeta" },
  { geo: "თიანეთი", latin: "Tianeti" },
  { geo: "დუშეთი", latin: "Dusheti" },
  { geo: "ყაზბეგი", latin: "Kazbegi", aliases: ["Stepantsminda"] },
  { geo: "წნორი", latin: "Tsnori" },
];

const COUNTRY_LATIN = new Set(["GEORGIA", "SAKARTVELO", "SAQARTVELO"]);

const KNOWN_PLACE_BY_LATIN: Record<string, string> = {};
const KNOWN_LATIN_BY_GEO: Record<string, string> = {};

for (const p of CANONICAL_PLACES) {
  KNOWN_LATIN_BY_GEO[p.geo] = p.latin;
  KNOWN_PLACE_BY_LATIN[latinNorm(p.latin)] = p.geo;
  KNOWN_PLACE_BY_LATIN[latinNorm(transliterateKa(p.geo))] = p.geo;
  for (const alias of p.aliases || []) {
    KNOWN_PLACE_BY_LATIN[latinNorm(alias)] = p.geo;
  }
}

function knownLatinForGeo(geo: string): string {
  if (KNOWN_LATIN_BY_GEO[geo]) return KNOWN_LATIN_BY_GEO[geo];
  const compact = geo.replace(/\s+/g, "");
  if (KNOWN_LATIN_BY_GEO[compact]) return KNOWN_LATIN_BY_GEO[compact];
  return "";
}

function knownPlaceFromLatin(latin: string): string {
  const tokens = latin
    .split(/[\s.,;:|/]+/)
    .map((t) => latinNorm(t))
    .filter((t) => t.length >= 3 && !COUNTRY_LATIN.has(t));

  const keys = Object.keys(KNOWN_PLACE_BY_LATIN).sort(
    (a, b) => b.length - a.length
  );

  for (const t of tokens) {
    if (KNOWN_PLACE_BY_LATIN[t]) return KNOWN_PLACE_BY_LATIN[t];
  }

  const n = latinNorm(latin);
  if (!n) return "";
  if (KNOWN_PLACE_BY_LATIN[n] && !COUNTRY_LATIN.has(n)) {
    return KNOWN_PLACE_BY_LATIN[n];
  }
  // Longer keys first so RUSTAVI wins over a short fragment inside GEORGIARUSTAVI
  for (const key of keys) {
    if (COUNTRY_LATIN.has(key) || key.length < 5) continue;
    if (n.includes(key)) return KNOWN_PLACE_BY_LATIN[key];
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

const RESIDENCE_LABEL_RE =
  /^(საცხოვრებელი\s*ადგილი|მისამართი|place\s*of\s*residence|permanent\s*address|address)\s*[:：]?\s*/i;

const JUNK_CITY_GEO =
  /^(მართვის|მოწმობა|ადგილი|საცხოვრებელი|კატეგორია|კატეგორიები|მისამართი|გაცემის|თარიღი)$/;

const JUNK_CITY_LATIN =
  /^(DRIVING|LICENCE|LICENSE|PLACE|RESIDENCE|CATEGORY|CATEGORIES|SERVICE|AGENCY|REPUBLIC|PERMANENT|ADDRESS|HOLDER|DATE|BIRTH|ISSUE|EXPIRY)$/i;

function stripGeoCountry(s: string): string {
  return s
    .replace(/^საქართველო\s*[,.\u060C\uFF0C]?\s*/i, "")
    .replace(/\s*საქართველო\s*[,.\u060C\uFF0C]?\s*/gi, " ")
    .replace(/^[,.\u060C\uFF0C:\-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLatCountry(s: string): string {
  return s
    .replace(/^Georgia\s*[,.\u060C\uFF0C]?\s*/i, "")
    .replace(/\b(?:Georgia|Sakartvelo|Saqartvelo)\b\s*[,.\u060C\uFF0C]?/gi, " ")
    .replace(/^[,.\u060C\uFF0C:\-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isJunkCity(geo: string, latin: string): boolean {
  const g = geo.replace(/\s+/g, "");
  const l = latin.trim();
  if (g && JUNK_CITY_GEO.test(g)) return true;
  if (l && JUNK_CITY_LATIN.test(l.split(/\s+/)[0] ?? "")) return true;
  if (COUNTRY_LATIN.has(latinNorm(l))) return true;
  return false;
}

/**
 * Field 8 on every Georgian DL is two lines:
 * `საქართველო, ქალაქი` then `Georgia, City`
 */
export function formatResidence(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  let raw = value.trim();
  if (!raw) return null;

  raw = raw
    .replace(/^8[\.\),:]?\s*/i, "")
    .replace(RESIDENCE_LABEL_RE, "")
    .replace(/\s+9[\.\),:][\s\S]*$/i, "")
    .replace(/\b(?:კატეგორი(?:ა|ები)?|Categor(?:y|ies)?)\b[\s\S]*$/i, "")
    .replace(/\d{1,2}\s*[./\-]\s*\d{1,2}\s*[./\-]\s*\d{2,4}/g, " ")
    .replace(/[|]+/g, "/")
    .replace(/\s+/g, " ")
    .trim();

  if (!raw || /^(საცხოვრებელი\s*ადგილი|place\s*of\s*residence|address)$/i.test(raw)) {
    return null;
  }

  let { geo, latin } = splitBilingualName(raw);

  geo = stripGeoCountry(geo);
  latin = stripLatCountry(latin);

  if (!geo && latin) {
    const known = knownPlaceFromLatin(latin);
    geo = known || latinToGeorgianApprox(latin);
    if (known) {
      latin = knownLatinForGeo(known) || titleLatin(latin);
    }
  }
  if (!latin && geo) {
    latin = knownLatinForGeo(geo) || transliterateKa(geo);
  }

  if (latin) {
    const known = knownPlaceFromLatin(latin);
    if (known) {
      geo = known;
      latin = knownLatinForGeo(known) || titleLatin(latin);
    }
  }
  if (geo) {
    const knownLat = knownLatinForGeo(geo);
    if (knownLat) latin = knownLat;
  }

  geo = stripGeoCountry(geo);
  latin = stripLatCountry(titleLatin(latin));

  if (!geo || !latin) return null;
  if (isJunkCity(geo, latin)) return null;

  return `საქართველო, ${geo} / Georgia, ${latin}`;
}

const QR_RESIDENCE_STOP =
  /^(C1E|D1E|D13|AM|A1|A2|B1|C1|D1|BE|CE|DE|[ABCDTS])$/i;

/**
 * Field 8 from the QR payload: country (`Georgia`) then the city after it.
 */
export function findResidenceFromQr(
  payload: string | null | undefined
): string | null {
  const raw = (payload || "").trim();
  if (!raw) return null;

  const tokens = raw
    .split(/[^A-Za-z\u10A0-\u10FF0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const isCountry = (t: string) =>
    /^(georgia|sakartvelo|saqartvelo|საქართველო)$/i.test(t);

  const isStop = (t: string) => {
    const u = t.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!u) return true;
    if (/^\d{6,}$/.test(u)) return true;
    if (/^[A-Z]{2}\d{7}$/.test(u)) return true;
    if (QR_RESIDENCE_STOP.test(u)) return true;
    if (JUNK_CITY_LATIN.test(t)) return true;
    return false;
  };

  const isCityLike = (t: string) => {
    if (t.length < 3) return false;
    if (isCountry(t) || isStop(t)) return false;
    if (/^\d+$/.test(t)) return false;
    return /[A-Za-z\u10A0-\u10FF]/.test(t);
  };

  for (let i = 0; i < tokens.length; i++) {
    if (!isCountry(tokens[i])) continue;
    const parts: string[] = [];
    for (let j = i + 1; j < tokens.length && parts.length < 2; j++) {
      const t = tokens[j];
      if (isStop(t) || isCountry(t)) break;
      if (!isCityLike(t)) break;
      parts.push(t);
      if (knownPlaceFromLatin(parts.join(" "))) break;
    }
    if (!parts.length) continue;
    const formatted = formatResidence(`Georgia, ${parts.join(" ")}`);
    if (formatted) return formatted;
  }
  return null;
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
