// Byte helpers shared by the browser and Node (>= 20). No Buffer, no dependencies.

/** @param {ArrayBuffer | ArrayBufferView} data @returns {Uint8Array} */
export function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError("expected bytes");
}

/** base64url without padding. @param {ArrayBuffer | ArrayBufferView} data */
export function toB64u(data) {
  const bytes = toBytes(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} text @returns {Uint8Array} */
export function fromB64u(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** @param {string} text */
export const utf8 = (text) => encoder.encode(text);
/** @param {ArrayBuffer | ArrayBufferView} bytes */
export const fromUtf8 = (bytes) => decoder.decode(toBytes(bytes));

/** @param {...(ArrayBuffer | ArrayBufferView)} parts */
export function concat(...parts) {
  const chunks = parts.map(toBytes);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function equalBytes(a, b) {
  const x = toBytes(a);
  const y = toBytes(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** @returns {Promise<Uint8Array>} */
export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toBytes(data)));
}

export function u32be(n) {
  return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** @param {string} prefix e.g. "m_" */
export function randomId(prefix) {
  return prefix + toB64u(randomBytes(9));
}
