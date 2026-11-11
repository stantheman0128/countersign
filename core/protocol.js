// The four objects in the protocol and how they are signed.
//
//   mandate       what a person allows their agent to ask for      signed by the person asking
//   request       the concrete ask an agent sends                  not signed; bounded by the mandate
//   confirmation  "yes, this exact request is mine, right now"     signed by the person asking
//   receipt       "I approved fulfilling this request"             signed by the person giving
//
// An envelope is { payload, sig }. The signature is a WebAuthn assertion whose challenge is
// SHA-256(canonical(payload)), so changing one character of the payload breaks it.

import { randomId, toB64u } from "./bytes.js";
import { hashPayload } from "./canonical.js";
import { verifyAssertion } from "./webauthn.js";

export const VERSION = 1;
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{ name: string, keyId: string }} Party
 * @typedef {{ bank: string, account: string, holder: string }} Payee
 * @typedef {{ keyId: string, publicKey: string, alg: number, sign(hash: Uint8Array): Promise<object> }} Signer
 */

/** A person's standing permission for their agent to make one kind of ask. */
export function buildMandate({ principal, agent, recipients, currency, maxAmount, payee, purpose, now = Date.now(), ttlMs = 3 * DAY_MS, maxUsesPerRecipient = 1 }) {
  return {
    v: VERSION,
    type: "countersign.mandate",
    id: randomId("m_"),
    principal: { name: principal.name, keyId: principal.keyId },
    agent: { name: agent?.name ?? "agent" },
    action: "payment_request",
    recipients: recipients.map((r) => ({ name: r.name, keyId: r.keyId })),
    limit: { currency, maxAmount },
    payee: { bank: payee.bank, account: payee.account, holder: payee.holder },
    purpose,
    issuedAt: now,
    expiresAt: now + ttlMs,
    maxUsesPerRecipient,
  };
}

/** The concrete ask. `mandate` may be null when the agent has nothing signed to show. */
export function buildRequest({ mandate, from, to, amount, currency, payee, memo, now = Date.now() }) {
  return {
    v: VERSION,
    type: "countersign.request",
    id: randomId("r_"),
    mandateId: mandate ? mandate.id : null,
    from: { name: from.name, keyId: from.keyId },
    to: { name: to.name, keyId: to.keyId },
    action: "payment_request",
    amount,
    currency,
    payee: { bank: payee.bank, account: payee.account, holder: payee.holder },
    memo,
    createdAt: now,
  };
}

/** What actually travels to the recipient: the ask plus whatever signed mandate backs it. */
export function buildBundle({ request, mandateEnvelope = null }) {
  return { v: VERSION, type: "countersign.bundle", request, mandate: mandateEnvelope };
}

export async function requestHash(request) {
  return toB64u(await hashPayload(request));
}

/** The recipient makes up a nonce; the asker signs it together with the request hash. */
export async function buildConfirmation({ request, nonce, principal, decision = "approve", now = Date.now() }) {
  return {
    v: VERSION,
    type: "countersign.confirmation",
    requestHash: await requestHash(request),
    nonce,
    principal: { name: principal.name, keyId: principal.keyId },
    decision,
    issuedAt: now,
  };
}

export async function buildReceipt({ request, payer, now = Date.now(), rail = "demo" }) {
  return {
    v: VERSION,
    type: "countersign.receipt",
    requestHash: await requestHash(request),
    payer: { name: payer.name, keyId: payer.keyId },
    amount: request.amount,
    currency: request.currency,
    rail,
    paidAt: now,
  };
}

/** @param {object} payload @param {Signer} signer */
export async function signPayload(payload, signer) {
  const sig = await signer.sign(await hashPayload(payload));
  return { payload, sig };
}

/** @param {{ payload: object, sig: object }} envelope @param {{ rpId: string, origins?: string[] }} expected */
export async function verifyEnvelope(envelope, expected) {
  if (!envelope || typeof envelope !== "object" || !envelope.payload || !envelope.sig) {
    return { ok: false, errors: ["malformed: not an envelope"], keyId: null, flags: null, origin: null, signCount: null };
  }
  return verifyAssertion({ hash: await hashPayload(envelope.payload), sig: envelope.sig, expected });
}
