/**
 * Bearer JWT for the Coinbase CDP facilitator, signed with Web Crypto so it runs on Cloudflare,
 * Vercel and Node with no extra dependency.
 *
 * Claim layout follows the CDP SDK (cdp-sdk auth.rs, docs.rs v0.6.0): header alg and kid, claims
 * sub = key id, iss = "cdp", iat = nbf = now, exp = now + 120, uris = ["METHOD host/path"].
 * Key formats: Ed25519 secret as base64 of 64 bytes (seed then public key), or an EC P-256 key in
 * PEM ("EC PRIVATE KEY" or "PRIVATE KEY").
 */
import type { AuthHeaders } from "./facilitator.ts";

export interface CdpCredentials {
  apiKeyId: string;
  apiKeySecret: string;
  /** Token lifetime in seconds. Default 120, as in the CDP SDK. */
  expiresInSeconds?: number;
}

const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
// AlgorithmIdentifier { id-ecPublicKey, prime256v1 }
const EC_P256_ALGORITHM = Uint8Array.from([
  0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d,
  0x03, 0x01, 0x07,
]);

const textEncoder = new TextEncoder();

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
}

function base64Url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function derLength(length: number): Uint8Array<ArrayBuffer> {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concat(...parts);
  return concat(Uint8Array.of(tag), derLength(body.length), body);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Wraps a SEC1 "EC PRIVATE KEY" in PKCS#8 so Web Crypto can import it. */
function sec1ToPkcs8(sec1: Uint8Array): Uint8Array<ArrayBuffer> {
  return der(0x30, Uint8Array.of(0x02, 0x01, 0x00), EC_P256_ALGORITHM, der(0x04, sec1));
}

interface SigningKey {
  alg: "EdDSA" | "ES256";
  key: CryptoKey;
  algorithm: AlgorithmIdentifier | EcdsaParams;
}

async function importSigningKey(secret: string): Promise<SigningKey> {
  const pem = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/.exec(secret);
  if (pem) {
    const label = pem[1] ?? "";
    const body = base64ToBytes(pem[2] ?? "");
    const pkcs8 = label === "EC PRIVATE KEY" ? sec1ToPkcs8(body) : body;
    const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
    ]);
    return { alg: "ES256", key, algorithm: { name: "ECDSA", hash: "SHA-256" } };
  }
  const raw = base64ToBytes(secret);
  if (raw.length !== 64) {
    throw new Error("CDP API key secret is neither a PEM EC key nor a 64-byte base64 Ed25519 key.");
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    concat(ED25519_PKCS8_PREFIX, raw.subarray(0, 32)),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return { alg: "EdDSA", key, algorithm: { name: "Ed25519" } };
}

export async function createCdpJwt(
  credentials: CdpCredentials,
  method: string,
  url: URL,
  signingKey?: SigningKey,
): Promise<string> {
  const signer = signingKey ?? (await importSigningKey(credentials.apiKeySecret));
  const now = Math.floor(Date.now() / 1000);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const header = { alg: signer.alg, kid: credentials.apiKeyId, typ: "JWT", nonce };
  const claims = {
    sub: credentials.apiKeyId,
    iss: "cdp",
    iat: now,
    nbf: now,
    exp: now + (credentials.expiresInSeconds ?? 120),
    uris: [`${method.toUpperCase()} ${url.host}${url.pathname}`],
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(signer.algorithm, signer.key, textEncoder.encode(signingInput)),
  );
  return `${signingInput}.${base64Url(signature)}`;
}

/**
 * Auth hook for `createFacilitator`. A fresh token is signed for every request, as the CDP SDK does;
 * the header nonce makes each one unique. The key is imported once per runtime instance.
 */
export function cdpAuth(credentials: CdpCredentials): AuthHeaders {
  let keyPromise: Promise<SigningKey> | undefined;
  return async (_op, method, url) => {
    keyPromise ??= importSigningKey(credentials.apiKeySecret).catch((error: unknown) => {
      keyPromise = undefined;
      throw error;
    });
    const token = await createCdpJwt(credentials, method, url, await keyPromise);
    return { authorization: `Bearer ${token}` };
  };
}
