// Deterministic JSON so that "the same ask" always hashes to the same 32 bytes.
// A strict subset of RFC 8785 (JCS): object keys sorted, no whitespace, and numbers
// restricted to safe integers so there is no float formatting to disagree about.
// Amounts are integers in the currency's smallest unit; times are integer milliseconds.

import { sha256, utf8 } from "./bytes.js";

/** @param {unknown} value @returns {string} */
export function canonicalize(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new Error("canonicalize: only safe integers are allowed");
      return String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
      const keys = Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
    }
    default:
      throw new Error("canonicalize: unsupported type " + typeof value);
  }
}

/** SHA-256 over the canonical form. This is the WebAuthn challenge. */
export async function hashPayload(payload) {
  return sha256(utf8(canonicalize(payload)));
}
