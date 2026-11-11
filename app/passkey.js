// Real passkeys: the private key stays inside the phone or laptop, and the operating system
// asks for a fingerprint, face or PIN before it signs. Nothing here is specific to the demo.

import { ALG_ES256, ALG_RS256, fromB64u, keyIdFromSpki, randomBytes, toB64u } from "../core/index.js";

/** Whether this browser can create a passkey that verifies the user on this device. */
export async function passkeySupport() {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
    return { available: false, reason: "no_webauthn" };
  }
  try {
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    return { available, reason: available ? null : "no_platform_authenticator" };
  } catch {
    return { available: false, reason: "probe_failed" };
  }
}

/**
 * Create a passkey and return the public half. `userName` is what the system sheet shows.
 * @returns {Promise<{ credentialId: string, publicKey: string, alg: number, keyId: string, transports: string[] }>}
 */
export async function createPasskey({ userName, displayName, rpName = "Countersign" }) {
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { name: rpName, id: location.hostname },
      user: { id: randomBytes(16), name: userName, displayName },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: "public-key", alg: ALG_ES256 },
        { type: "public-key", alg: ALG_RS256 },
      ],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: 120000,
    },
  });
  const response = credential.response;
  const spki = typeof response.getPublicKey === "function" ? response.getPublicKey() : null;
  const alg = typeof response.getPublicKeyAlgorithm === "function" ? response.getPublicKeyAlgorithm() : null;
  if (!spki || (alg !== ALG_ES256 && alg !== ALG_RS256)) {
    throw new Error("This browser did not return a public key Countersign can use (ES256 or RS256).");
  }
  return {
    credentialId: toB64u(credential.rawId),
    publicKey: toB64u(spki),
    alg,
    keyId: await keyIdFromSpki(new Uint8Array(spki)),
    transports: typeof response.getTransports === "function" ? response.getTransports() : [],
  };
}

/** A signer backed by that passkey. Each call to sign() raises the system prompt. */
export function passkeySigner(identity) {
  return {
    kind: "passkey",
    keyId: identity.keyId,
    publicKey: identity.publicKey,
    alg: identity.alg,
    /** @param {Uint8Array} hash */
    async sign(hash) {
      const descriptor = { type: "public-key", id: fromB64u(identity.credentialId) };
      if (identity.transports && identity.transports.length) descriptor.transports = identity.transports;
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: hash,
          rpId: location.hostname,
          allowCredentials: [descriptor],
          userVerification: "required",
          timeout: 120000,
        },
      });
      const r = assertion.response;
      return {
        alg: identity.alg,
        publicKey: identity.publicKey,
        authenticatorData: toB64u(r.authenticatorData),
        clientDataJSON: toB64u(r.clientDataJSON),
        signature: toB64u(r.signature),
      };
    },
  };
}
