// Verifying a WebAuthn assertion with nothing but WebCrypto.
//
// A passkey does not sign your data directly. It signs
//     authenticatorData || SHA-256(clientDataJSON)
// and clientDataJSON carries the challenge. Countersign puts the hash of the mandate in the
// challenge, so a valid assertion means: this key approved exactly these bytes.

import { concat, equalBytes, fromB64u, fromUtf8, sha256, toB64u, toBytes, utf8 } from "./bytes.js";

export const ALG_ES256 = -7;
export const ALG_RS256 = -257;

const FLAG_UP = 0x01; // user present
const FLAG_UV = 0x04; // user verified (biometric or device PIN)
const FLAG_BE = 0x08; // backup eligible: the passkey may sync between devices
const FLAG_BS = 0x10; // backup state: it is currently synced

export function parseFlags(byte) {
  return {
    up: (byte & FLAG_UP) !== 0,
    uv: (byte & FLAG_UV) !== 0,
    backupEligible: (byte & FLAG_BE) !== 0,
    backedUp: (byte & FLAG_BS) !== 0,
  };
}

export function flagsByte({ up = true, uv = true, backupEligible = false, backedUp = false } = {}) {
  return (up ? FLAG_UP : 0) | (uv ? FLAG_UV : 0) | (backupEligible ? FLAG_BE : 0) | (backedUp ? FLAG_BS : 0);
}

/** ECDSA signatures arrive DER-encoded from authenticators; WebCrypto wants raw r||s. */
export function derToRaw(der, size = 32) {
  const b = toBytes(der);
  let i = 0;
  if (b[i++] !== 0x30) throw new Error("bad DER: expected a sequence");
  if (b[i++] & 0x80) i += b[i - 1] & 0x7f; // skip a long-form length
  const out = new Uint8Array(size * 2);
  for (let part = 0; part < 2; part++) {
    if (b[i++] !== 0x02) throw new Error("bad DER: expected an integer");
    let len = b[i++];
    if (len === undefined || len & 0x80) throw new Error("bad DER: integer length");
    let start = i;
    i += len;
    if (i > b.length) throw new Error("bad DER: truncated");
    while (len > size && b[start] === 0) {
      start++;
      len--;
    }
    if (len > size) throw new Error("bad DER: integer too large");
    out.set(b.subarray(start, start + len), part * size + (size - len));
  }
  return out;
}

export function rawToDer(raw) {
  const b = toBytes(raw);
  const size = b.length / 2;
  const encodeInt = (x) => {
    let s = 0;
    while (s < x.length - 1 && x[s] === 0) s++;
    let v = x.subarray(s);
    if (v[0] & 0x80) v = concat(Uint8Array.of(0), v);
    return concat(Uint8Array.of(0x02, v.length), v);
  };
  const r = encodeInt(b.subarray(0, size));
  const s = encodeInt(b.subarray(size));
  const len = r.length + s.length;
  return concat(len < 0x80 ? Uint8Array.of(0x30, len) : Uint8Array.of(0x30, 0x81, len), r, s);
}

/** Key ID = SHA-256 thumbprint of the SubjectPublicKeyInfo bytes, base64url. */
export async function keyIdFromSpki(spki) {
  return toB64u(await sha256(spki));
}

/** A short, human-comparable form of a key ID, shown when pairing. */
export function fingerprint(keyId) {
  return keyId.slice(0, 4) + " " + keyId.slice(4, 8) + " " + keyId.slice(8, 12);
}

async function verifySignature(spki, alg, signature, data) {
  if (alg === ALG_ES256) {
    const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(signature), data);
  }
  if (alg === ALG_RS256) {
    const key = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, data);
  }
  throw new Error("unsupported algorithm " + alg);
}

/**
 * @param {object} args
 * @param {Uint8Array} args.hash         the 32 bytes that were supposed to be signed
 * @param {object} args.sig              { alg, publicKey, authenticatorData, clientDataJSON, signature } (base64url)
 * @param {object} args.expected         { rpId: string, origins?: string[] }
 * @returns {Promise<{ ok: boolean, errors: string[], keyId: string | null, flags: object | null, origin: string | null, signCount: number | null }>}
 */
export async function verifyAssertion({ hash, sig, expected }) {
  const errors = [];
  let keyId = null;
  let flags = null;
  let origin = null;
  let signCount = null;
  try {
    const authData = fromB64u(sig.authenticatorData);
    const clientDataJSON = fromB64u(sig.clientDataJSON);
    const signature = fromB64u(sig.signature);
    const spki = fromB64u(sig.publicKey);
    keyId = await keyIdFromSpki(spki);
    if (authData.length < 37) throw new Error("authenticatorData too short");

    const clientData = JSON.parse(fromUtf8(clientDataJSON));
    origin = typeof clientData.origin === "string" ? clientData.origin : null;
    flags = parseFlags(authData[32]);
    signCount = ((authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36]) >>> 0;

    if (clientData.type !== "webauthn.get") errors.push("client_data_type");
    if (clientData.challenge !== toB64u(hash)) errors.push("challenge_mismatch");
    if (expected.origins && !expected.origins.includes(origin)) errors.push("origin_mismatch");
    if (!equalBytes(authData.subarray(0, 32), await sha256(utf8(expected.rpId)))) errors.push("rp_id_mismatch");
    if (!flags.up) errors.push("user_not_present");

    const signed = concat(authData, await sha256(clientDataJSON));
    if (!(await verifySignature(spki, sig.alg, signature, signed))) errors.push("bad_signature");
  } catch (err) {
    errors.push("malformed: " + (err && err.message ? err.message : String(err)));
  }
  return { ok: errors.length === 0, errors, keyId, flags, origin, signCount };
}
