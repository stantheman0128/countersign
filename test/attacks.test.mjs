// The attack list, written as tests. Each one is something a scammer, a thief or a
// confused agent could try, and the single check that is expected to stop it.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBundle,
  buildConfirmation,
  buildReceipt,
  buildRequest,
  createSoftAuthenticator,
  recordUse,
  signPayload,
  verifyConfirmation,
  verifyReceipt,
  verifyRequest,
} from "../core/index.js";
import { ATTACKER_ACCOUNT, MING_ACCOUNT, ORIGIN, RP_ID, expected, failed, makeAsk, makeWorld } from "./helpers.mjs";

const check = (world, bundle, extra = {}) =>
  verifyRequest({ bundle, me: world.stan, contacts: world.stanContacts, ledger: world.ledger, expected, ...extra });

test("a real ask, inside what Ming signed, passes every check", async () => {
  const world = await makeWorld();
  const { bundle } = await makeAsk(world);
  const verdict = await check(world, bundle);
  assert.equal(verdict.ok, true);
  assert.deepEqual(failed(verdict), []);
  assert.equal(verdict.principal.name, "Ming");
  assert.equal(verdict.flags.uv, true);
});

test("no mandate at all: a message that merely claims to be from Ming", async () => {
  const world = await makeWorld();
  const request = buildRequest({ mandate: null, from: world.ming, to: world.stan, amount: 4800, currency: "TWD", payee: ATTACKER_ACCOUNT, memo: "deposit" });
  const verdict = await check(world, buildBundle({ request }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "has_mandate");
  assert.equal(verdict.canAskLive, true, "Stan can still ask the real Ming directly");
});

test("impostor signs a mandate with their own key and calls themselves Ming", async () => {
  const world = await makeWorld();
  const { eve } = world;
  const fakeMing = { name: "Ming", keyId: eve.keyId };
  const { bundle } = await makeAsk(world, {
    mandate: { principal: fakeMing, payee: ATTACKER_ACCOUNT },
    request: { from: fakeMing, payee: ATTACKER_ACCOUNT },
    signer: eve.signer,
  });
  const verdict = await check(world, bundle);
  assert.equal(verdict.checks.find((c) => c.id === "signature_valid").ok, true, "the signature itself is fine");
  assert.deepEqual(failed(verdict), ["principal_known"]);
  assert.equal(verdict.principal, null);
});

test("impostor names Ming's real key in the mandate but signs with their own", async () => {
  const world = await makeWorld();
  const { bundle } = await makeAsk(world, { mandate: { payee: ATTACKER_ACCOUNT }, request: { payee: ATTACKER_ACCOUNT }, signer: world.eve.signer });
  const verdict = await check(world, bundle);
  assert.deepEqual(failed(verdict), ["signer_is_claimed_principal", "principal_known"]);
});

test("the signed mandate is edited afterwards (limit raised)", async () => {
  const world = await makeWorld();
  const { bundle } = await makeAsk(world);
  bundle.mandate.payload.limit.maxAmount = 480000;
  bundle.request.amount = 480000;
  const verdict = await check(world, bundle);
  const sig = verdict.checks.find((c) => c.id === "signature_valid");
  assert.equal(sig.ok, false);
  assert.deepEqual(sig.errors, ["challenge_mismatch"]);
});

test("hijacked agent raises the amount beyond the mandate", async () => {
  const world = await makeWorld();
  const { bundle } = await makeAsk(world, { request: { amount: 48000 } });
  assert.deepEqual(failed(await check(world, bundle)), ["amount_within_limit"]);
});

test("hijacked agent swaps the account the money goes to", async () => {
  const world = await makeWorld();
  const { bundle } = await makeAsk(world, { request: { payee: ATTACKER_ACCOUNT } });
  assert.deepEqual(failed(await check(world, bundle)), ["payee_matches"]);
});

test("a different currency is not inside the limit", async () => {
  const world = await makeWorld();
  const { bundle } = await makeAsk(world, { request: { currency: "USD" } });
  assert.deepEqual(failed(await check(world, bundle)), ["amount_within_limit"]);
});

test("zero, negative and fractional amounts are refused", async () => {
  const world = await makeWorld();
  for (const amount of [0, -1, 12.5]) {
    const { bundle } = await makeAsk(world, { request: { amount } });
    assert.deepEqual(failed(await check(world, bundle)), ["amount_within_limit"], String(amount));
  }
});

test("the mandate is forwarded to someone it does not name", async () => {
  const world = await makeWorld();
  const { bundle } = await makeAsk(world, { request: { to: { name: "Eve", keyId: world.eve.keyId } } });
  const asEve = await verifyRequest({ bundle, me: world.eve, contacts: world.stanContacts, ledger: world.ledger, expected });
  assert.deepEqual(failed(asEve), ["recipient_is_me"]);
});

test("the mandate has expired", async () => {
  const world = await makeWorld();
  const { bundle, mandate } = await makeAsk(world);
  const verdict = await check(world, bundle, { now: mandate.expiresAt + 1 });
  assert.deepEqual(failed(verdict), ["not_expired"]);
});

test("a mandate dated in the future is refused", async () => {
  const world = await makeWorld();
  const later = Date.now() + 60 * 60 * 1000;
  const { bundle } = await makeAsk(world, { mandate: { issuedAt: later, expiresAt: later + 1000 } });
  assert.deepEqual(failed(await check(world, bundle)), ["not_expired"]);
});

test("replay: the same ask, and a fresh ask under a spent mandate, are both refused", async () => {
  const world = await makeWorld();
  const { bundle, mandate, mandateEnvelope } = await makeAsk(world);
  assert.equal((await check(world, bundle)).ok, true);
  recordUse(world.ledger, bundle);
  assert.deepEqual(failed(await check(world, bundle)), ["not_replayed"]);

  const again = buildRequest({ mandate, from: world.ming, to: world.stan, amount: 100, currency: "TWD", payee: MING_ACCOUNT, memo: "again" });
  assert.deepEqual(failed(await check(world, buildBundle({ request: again, mandateEnvelope }))), ["not_replayed"]);
});

test("a request that points at a different mandate is refused", async () => {
  const world = await makeWorld();
  const { bundle } = await makeAsk(world, { request: { mandateId: "m_somethingelse" } });
  assert.deepEqual(failed(await check(world, bundle)), ["mandate_matches_request"]);
});

test("a signature made without user verification does not count as a person approving", async () => {
  const world = await makeWorld({ ming: { userVerified: false } });
  const { bundle } = await makeAsk(world);
  assert.deepEqual(failed(await check(world, bundle)), ["user_verified"]);
});

test("a signature made for another site or origin is refused", async () => {
  const world = await makeWorld();
  const { bundle } = await makeAsk(world);
  const otherRp = await verifyRequest({ bundle, me: world.stan, contacts: world.stanContacts, ledger: world.ledger, expected: { rpId: "evil.example", origins: [ORIGIN] } });
  assert.deepEqual(otherRp.checks.find((c) => c.id === "signature_valid").errors, ["rp_id_mismatch"]);
  const otherOrigin = await verifyRequest({ bundle, me: world.stan, contacts: world.stanContacts, ledger: world.ledger, expected: { rpId: RP_ID, origins: ["https://evil.example"] } });
  assert.deepEqual(otherOrigin.checks.find((c) => c.id === "signature_valid").errors, ["origin_mismatch"]);
});

test("garbage in the signature fields fails closed", async () => {
  const world = await makeWorld();
  const { bundle } = await makeAsk(world);
  bundle.mandate.sig.signature = "AAAA";
  assert.equal((await check(world, bundle)).ok, false);
  bundle.mandate.sig = { alg: -7, publicKey: "not base64!", authenticatorData: "", clientDataJSON: "", signature: "" };
  const verdict = await check(world, bundle);
  assert.equal(verdict.ok, false);
  assert.match(verdict.checks.find((c) => c.id === "signature_valid").errors[0], /^malformed/);
});

test("live confirmation: Ming's own device approves one exact out-of-scope request", async () => {
  const world = await makeWorld();
  const request = buildRequest({ mandate: null, from: world.ming, to: world.stan, amount: 100000, currency: "TWD", payee: MING_ACCOUNT, memo: "loan" });
  const nonce = "n_stan_made_this_up";
  const envelope = await signPayload(await buildConfirmation({ request, nonce, principal: world.ming }), world.ming.signer);
  const args = { envelope, request, nonce, contacts: world.stanContacts, expected };

  assert.equal((await verifyConfirmation(args)).ok, true);
  assert.equal((await verifyConfirmation({ ...args, nonce: "n_other" })).reason, "nonce_match");
  assert.equal((await verifyConfirmation({ ...args, now: Date.now() + 6 * 60 * 1000 })).reason, "fresh");
  assert.equal((await verifyConfirmation({ ...args, request: { ...request, amount: 1000000 } })).reason, "request_hash_match");
});

test("live confirmation signed by anyone but the claimed sender is refused", async () => {
  const world = await makeWorld();
  const request = buildRequest({ mandate: null, from: world.ming, to: world.stan, amount: 100000, currency: "TWD", payee: MING_ACCOUNT, memo: "loan" });
  const envelope = await signPayload(await buildConfirmation({ request, nonce: "n1", principal: world.ming }), world.eve.signer);
  const verdict = await verifyConfirmation({ envelope, request, nonce: "n1", contacts: world.stanContacts, expected });
  assert.equal(verdict.reason, "principal_known");
});

test("live confirmation carrying a refusal is not an approval", async () => {
  const world = await makeWorld();
  const request = buildRequest({ mandate: null, from: world.ming, to: world.stan, amount: 100000, currency: "TWD", payee: MING_ACCOUNT, memo: "loan" });
  const envelope = await signPayload(await buildConfirmation({ request, nonce: "n1", principal: world.ming, decision: "deny" }), world.ming.signer);
  const verdict = await verifyConfirmation({ envelope, request, nonce: "n1", contacts: world.stanContacts, expected });
  assert.equal(verdict.reason, "decision_approve");
  assert.equal(verdict.decision, "deny");
});

test("receipt: the giver signs the same request hash, so both sides are on record", async () => {
  const world = await makeWorld();
  const { request } = await makeAsk(world);
  const envelope = await signPayload(await buildReceipt({ request, payer: world.stan }), world.stan.signer);
  assert.equal((await verifyReceipt({ envelope, request, payerKeyId: world.stan.keyId, expected })).ok, true);
  assert.equal((await verifyReceipt({ envelope, request: { ...request, amount: 1 }, payerKeyId: world.stan.keyId, expected })).ok, false);
  assert.equal((await verifyReceipt({ envelope, request, payerKeyId: world.eve.keyId, expected })).ok, false);
});

test("a software key can be exported and restored, and still verifies", async () => {
  const first = await createSoftAuthenticator({ rpId: RP_ID, origin: ORIGIN });
  const restored = await createSoftAuthenticator({ rpId: RP_ID, origin: ORIGIN, jwk: await first.exportJwk() });
  assert.equal(restored.keyId, first.keyId);
});
