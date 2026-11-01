/**
 * Header codec. x402 v2 carries every protocol object in an HTTP header as base64 of UTF-8 JSON.
 * Decoding accepts standard and URL-safe base64; encoding always emits standard base64.
 */

/** Largest PAYMENT-SIGNATURE header accepted. Real payloads are under 2 KB; this leaves room for smart-wallet signatures. */
export const MAX_HEADER_BYTES = 16 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeHeader(value: unknown): string {
  const bytes = encoder.encode(JSON.stringify(value));
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export class HeaderDecodeError extends Error {
  override readonly name = "HeaderDecodeError";
}

export function decodeHeader(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new HeaderDecodeError("header is empty");
  if (trimmed.length > MAX_HEADER_BYTES) throw new HeaderDecodeError("header is too large");
  const standard = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new HeaderDecodeError("header is not valid base64");
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new HeaderDecodeError("header is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HeaderDecodeError("header is not valid JSON");
  }
}
