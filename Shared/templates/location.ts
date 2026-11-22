/** Places on the map as reports print them: a QR code, and the same link to click. */
import { qrPng } from "../../IdentityAcess_Services/Utils/qr.ts";
import type { FieldDef } from "./definition.ts";

export interface MapPlace {
  url: string;
  /** What is printed as the link. */
  label: string;
  /** What else was written in the same answer. */
  rest: string;
  qr: Uint8Array;
}

// The same labels the app fills from GPS (gpIsLocationField).
const LOCATION_FIELD = /google\s*maps|qr\s*code|location|إحداثي|تحديد\s*الموقع|رابط\s*الموقع|لوكيشن|الخريطة|خريطة/i;
const MAP_LINK =
  /https?:\/\/(?:maps\.google\.com\/|(?:www\.)?google\.com\/maps[/?]|maps\.app\.goo\.gl\/|goo\.gl\/maps\/)[\w\-.~:/?#@!$&'()*+,;=%]*/i;
const PAIR = /^\s*(-?\d{1,2}\.\d{3,})\s*[,،]\s*(-?\d{1,3}\.\d{3,})\s*$/;
// Longer links make a code too dense to scan at the printed size.
const MAX_LINK = 300;

/** No space after the comma: inside Arabic text a space makes the two numbers change places. */
const coordinates = (lat: number, lng: number) => `${lat.toFixed(5)},${lng.toFixed(5)}`;

export function pointPlace(lat: number, lng: number): MapPlace {
  const url = `https://maps.google.com/?q=${lat},${lng}`;
  return { url, label: coordinates(lat, lng), rest: "", qr: qrPng(url) };
}

/**
 * The place in an answer: a map link in any text, or bare coordinates in a location field.
 * Nothing is guessed: an answer without either prints as written.
 */
export function answerPlace(field: Pick<FieldDef, "type" | "label"> | undefined, value: unknown): MapPlace | null {
  if (!field || !["text", "textarea"].includes(field.type) || typeof value !== "string") return null;
  const link = MAP_LINK.exec(value)?.[0].replace(/[.,;:!)'*]+$/, "");
  if (link) {
    if (link.length > MAX_LINK) return null;
    const found = /(?:[?&](?:q|query)=|@)(-?\d{1,2}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i.exec(link);
    return {
      url: link,
      label: found ? coordinates(Number(found[1]), Number(found[2])) : "Google Maps",
      rest: value.replace(link, "").trim(),
      qr: qrPng(link),
    };
  }
  const pair = LOCATION_FIELD.test(field.label) ? PAIR.exec(value) : null;
  if (!pair || Math.abs(Number(pair[1])) > 90 || Math.abs(Number(pair[2])) > 180) return null;
  return pointPlace(Number(pair[1]), Number(pair[2]));
}
