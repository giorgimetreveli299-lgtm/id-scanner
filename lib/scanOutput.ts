import {
  formatBilingualName,
  formatBilingualPlace,
  formatResidence,
  splitBilingualName,
} from "./georgianTranslit";
import type { LicenseFields } from "./parseLicense";
import type { ScanResult } from "./vision";

function splitPair(value: string | null | undefined): { geo: string; lat: string } {
  const parts = splitBilingualName(value || "");
  return { geo: parts.geo || "", lat: parts.latin || "" };
}

export function buildLicenseDisplay(fields: LicenseFields) {
  const surname = splitPair(formatBilingualName(fields.surname));
  const givenNames = splitPair(formatBilingualName(fields.givenNames));
  const placeOfBirth = splitPair(formatBilingualPlace(fields.placeOfBirth));
  const residence = splitPair(formatResidence(fields.residence));

  return {
    surname_geo: surname.geo,
    surname_lat: surname.lat,
    givenNames_geo: givenNames.geo,
    givenNames_lat: givenNames.lat,
    dateOfBirth: fields.dateOfBirth || "",
    placeOfBirth_geo: placeOfBirth.geo,
    placeOfBirth_lat: placeOfBirth.lat,
    issueDate: fields.issueDate || "",
    expiryDate: fields.expiryDate || "",
    issuingAuthority: fields.issuingAuthority || "",
    personalNumber: fields.personalNumber || "",
    licenseNumber: fields.licenseNumber || "",
    residence_geo: residence.geo,
    residence_lat: residence.lat,
    category: fields.category || "",
  };
}

export function buildLicenseApiPayload(result: ScanResult) {
  return {
    ok: true as const,
    fields: result.fields,
    display: buildLicenseDisplay(result.fields),
    qrCodeValue: result.qrCodeValue,
    holderPhotoDataUrl: result.holderPhotoDataUrl,
    holderSignatureDataUrl: result.holderSignatureDataUrl,
    qrCodeDataUrl: result.qrCodeDataUrl,
  };
}

export function countFilledDisplay(display: Record<string, string> | null | undefined): number {
  const keys = [
    "surname_geo",
    "givenNames_geo",
    "dateOfBirth",
    "licenseNumber",
    "personalNumber",
  ];
  return keys.filter((k) => Boolean(display?.[k])).length;
}
