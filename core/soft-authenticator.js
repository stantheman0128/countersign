// A software authenticator that emits assertions in the same wire format as a real passkey.
//
// It exists for three honest reasons: unit tests, the command-line demo, and playing the
// attacker in the browser demo. It is NOT how a person should sign: the private key sits in
// ordinary memory, and nothing checks a fingerprint. Real use goes through app/passkey.js.

import { concat, sha256, toB64u, u32be, utf8 } from "./bytes.js";
import { ALG_ES256, flagsByte, keyIdFromSpki, rawToDer } from "./webauthn.js";

const EC = { name: "ECDSA", namedCurve: "P-256" };

/**
 * @param {object} options
 * @param {string} options.rpId
 * @param {string} options.origin
 * @param {boolean} [options.userVerified]  set false to model a signature made without biometrics
 * @param {JsonWebKey} [options.jwk]        restore a previously exported private key
 */
export async function createSoftAuthenticator({ rpId, origin, userVerified = true, jwk }) {
  let privateKey;
  let publicKey;
  if (jwk) {
    privateKey = await crypto.subtle.importKey("jwk", jwk, EC, true, ["sign"]);
    const { d, key_ops, ...pub } = jwk;
    publicKey = await crypto.subtle.importKey("jwk", pub, EC, true, ["verify"]);
  } else {
    ({ privateKey, publicKey } = await crypto.subtle.generateKey(EC, true, ["sign", "verify"]));
  }
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  const publicKeyB64u = toB64u(spki);
  const keyId = await keyIdFromSpki(spki);
  let counter = 0;

  return {
    kind: "software",
    alg: ALG_ES256,
    publicKey: publicKeyB64u,
    keyId,
    /** @param {Uint8Array} hash */
    async sign(hash) {
      const clientDataJSON = utf8(
        JSON.stringify({ type: "webauthn.get", challenge: toB64u(hash), origin, crossOrigin: false }),
      );
      const authenticatorData = concat(
        await sha256(utf8(rpId)),
        Uint8Array.of(flagsByte({ up: true, uv: userVerified })),
        u32be(++counter),
      );
      const signed = concat(authenticatorData, await sha256(clientDataJSON));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, signed));
      return {
        alg: ALG_ES256,
        publicKey: publicKeyB64u,
        authenticatorData: toB64u(authenticatorData),
        clientDataJSON: toB64u(clientDataJSON),
        signature: toB64u(rawToDer(raw)),
      };
    },
    exportJwk() {
      return crypto.subtle.exportKey("jwk", privateKey);
    },
  };
}
