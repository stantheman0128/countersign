// What the receiving side checks before it believes an ask.
//
// Every check is independent and reported by id, so an interface can say exactly why
// something was blocked ("the account is not the one Ming signed") instead of "invalid".

import { canonicalize } from "./canonical.js";
import { requestHash, verifyEnvelope } from "./protocol.js";

/** Display order. An ask passes only if every one of these is true. */
export const REQUEST_CHECKS = [
  "has_mandate", //                 something signed came with the ask
  "signature_valid", //             the signature covers exactly this mandate
  "signer_is_claimed_principal", // the key that signed is the key the mandate names
  "principal_known", //             that key belongs to someone I paired with
  "user_verified", //               the device checked a fingerprint, face or PIN
  "mandate_matches_request", //     the ask points at this mandate and this kind of action
  "recipient_is_me", //             I am the one the mandate allows to be asked
  "amount_within_limit", //         amount and currency stay inside the mandate
  "payee_matches", //               money goes to the account that was signed
  "not_expired", //                 the mandate is in its validity window
  "not_replayed", //                it has not been used up
];

export const CONFIRMATION_CHECKS = [
  "signature_valid",
  "principal_known",
  "user_verified",
  "request_hash_match",
  "nonce_match",
  "fresh",
  "decision_approve",
];

/**
 * @typedef {{ [keyId: string]: { name: string, publicKey: string, alg: number } }} Contacts
 * @typedef {{ uses: { [mandateId: string]: number }, seen: { [requestId: string]: true } }} Ledger
 */

export function newLedger() {
  return { uses: {}, seen: {} };
}

/**
 * @param {object} args
 * @param {object} args.bundle                 { request, mandate: envelope | null }
 * @param {{ name: string, keyId: string }} args.me
 * @param {Contacts} args.contacts             people I have paired with, keyed by key ID
 * @param {Ledger} args.ledger                 what I have already honoured
 * @param {{ rpId: string, origins?: string[] }} args.expected
 * @param {number} [args.now]
 * @param {number} [args.skewMs]               tolerated clock difference for issuedAt
 */
export async function verifyRequest({ bundle, me, contacts, ledger, expected, now = Date.now(), skewMs = 2 * 60 * 1000 }) {
  const request = bundle?.request ?? null;
  const envelope = bundle?.mandate ?? null;
  const mandate = envelope?.payload ?? null;
  /** @type {Record<string, { id: string, ok: boolean, skipped?: boolean, [k: string]: unknown }>} */
  const results = {};
  const set = (id, ok, detail = {}) => {
    results[id] = { id, ok: Boolean(ok), ...detail };
  };

  const hasMandate = Boolean(request && envelope && mandate && envelope.sig);
  set("has_mandate", hasMandate);

  let signerKeyId = null;
  let flags = null;
  if (hasMandate) {
    const sig = await verifyEnvelope(envelope, expected);
    signerKeyId = sig.keyId;
    flags = sig.flags;
    set("signature_valid", sig.ok, { errors: sig.errors });

    const claimed = mandate.principal?.keyId;
    set("signer_is_claimed_principal", signerKeyId !== null && signerKeyId === claimed && request.from?.keyId === claimed, {
      claimedName: mandate.principal?.name,
    });

    const contact = signerKeyId ? contacts[signerKeyId] : undefined;
    set("principal_known", Boolean(contact), { name: contact?.name, claimedName: mandate.principal?.name });

    set("user_verified", Boolean(flags?.uv));

    set(
      "mandate_matches_request",
      mandate.v === 1 && mandate.type === "countersign.mandate" && request.mandateId === mandate.id && request.action === mandate.action,
    );

    const namesMe = Array.isArray(mandate.recipients) && mandate.recipients.some((r) => r.keyId === me.keyId);
    set("recipient_is_me", namesMe && request.to?.keyId === me.keyId, { to: request.to?.name });

    const max = mandate.limit?.maxAmount;
    set(
      "amount_within_limit",
      Number.isSafeInteger(request.amount) && request.amount > 0 && request.currency === mandate.limit?.currency && request.amount <= max,
      { amount: request.amount, max, currency: mandate.limit?.currency },
    );

    set("payee_matches", canonicalize(request.payee ?? null) === canonicalize(mandate.payee ?? null), {
      requested: request.payee,
      approved: mandate.payee,
    });

    set("not_expired", mandate.issuedAt <= now + skewMs && now <= mandate.expiresAt, { expiresAt: mandate.expiresAt });

    const used = ledger.uses[mandate.id] ?? 0;
    set("not_replayed", used < (mandate.maxUsesPerRecipient ?? 1) && !ledger.seen[request.id], { used });
  }

  const checks = REQUEST_CHECKS.map((id) => results[id] ?? { id, ok: false, skipped: true });
  const firstFailure = checks.find((c) => !c.ok) ?? null;
  const claimedSender = request?.from?.keyId ? contacts[request.from.keyId] : undefined;

  return {
    ok: firstFailure === null,
    checks,
    reason: firstFailure ? firstFailure.id : null,
    /** Who actually signed, if that key is one of my contacts. */
    principal: signerKeyId && contacts[signerKeyId] ? { name: contacts[signerKeyId].name, keyId: signerKeyId } : null,
    flags,
    /** If the ask claims to come from someone I paired with, I can ask that person's device directly. */
    canAskLive: Boolean(claimedSender),
    claimedSender: claimedSender ? { name: claimedSender.name, keyId: request.from.keyId } : null,
  };
}

/** Call once the ask has been honoured, so the same mandate cannot be spent twice. */
export function recordUse(ledger, bundle) {
  const mandateId = bundle.mandate?.payload?.id;
  if (mandateId) ledger.uses[mandateId] = (ledger.uses[mandateId] ?? 0) + 1;
  ledger.seen[bundle.request.id] = true;
  return ledger;
}

/**
 * Live confirmation: the recipient made up `nonce` a moment ago and asked the claimed sender's
 * own device to sign it together with the hash of the request.
 */
export async function verifyConfirmation({ envelope, request, nonce, contacts, expected, now = Date.now(), maxAgeMs = 5 * 60 * 1000 }) {
  const payload = envelope?.payload ?? {};
  const sig = await verifyEnvelope(envelope, expected);
  const contact = sig.keyId ? contacts[sig.keyId] : undefined;
  const results = {
    signature_valid: { ok: sig.ok, errors: sig.errors },
    principal_known: { ok: Boolean(contact) && sig.keyId === request.from?.keyId && payload.principal?.keyId === sig.keyId, name: contact?.name },
    user_verified: { ok: Boolean(sig.flags?.uv) },
    request_hash_match: { ok: payload.type === "countersign.confirmation" && payload.requestHash === (await requestHash(request)) },
    nonce_match: { ok: typeof nonce === "string" && nonce.length > 0 && payload.nonce === nonce },
    fresh: { ok: Number.isSafeInteger(payload.issuedAt) && Math.abs(now - payload.issuedAt) <= maxAgeMs, ageMs: now - payload.issuedAt },
    decision_approve: { ok: payload.decision === "approve", decision: payload.decision },
  };
  const checks = CONFIRMATION_CHECKS.map((id) => ({ id, ...results[id], ok: Boolean(results[id].ok) }));
  const firstFailure = checks.find((c) => !c.ok) ?? null;
  return {
    ok: firstFailure === null,
    checks,
    reason: firstFailure ? firstFailure.id : null,
    principal: contact ? { name: contact.name, keyId: sig.keyId } : null,
    decision: payload.decision ?? null,
  };
}

/** A receipt is the giver's signature over the same request hash: the second half of "countersign". */
export async function verifyReceipt({ envelope, request, payerKeyId, expected }) {
  const payload = envelope?.payload ?? {};
  const sig = await verifyEnvelope(envelope, expected);
  const ok =
    sig.ok &&
    Boolean(sig.flags?.uv) &&
    sig.keyId === payerKeyId &&
    payload.type === "countersign.receipt" &&
    payload.payer?.keyId === payerKeyId &&
    payload.requestHash === (await requestHash(request)) &&
    payload.amount === request.amount &&
    payload.currency === request.currency;
  return { ok, keyId: sig.keyId, errors: sig.errors };
}
