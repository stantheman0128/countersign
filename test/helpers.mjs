import { buildBundle, buildMandate, buildRequest, createSoftAuthenticator, newLedger, signPayload } from "../core/index.js";

export const RP_ID = "countersign.example";
export const ORIGIN = "https://countersign.example";
export const expected = { rpId: RP_ID, origins: [ORIGIN] };

export const MING_ACCOUNT = { bank: "808", account: "0123456781234", holder: "Ming" };
export const ATTACKER_ACCOUNT = { bank: "822", account: "0000999999999", holder: "Ming" };

async function person(name, options = {}) {
  const auth = await createSoftAuthenticator({ rpId: RP_ID, origin: ORIGIN, ...options });
  return { name, keyId: auth.keyId, publicKey: auth.publicKey, alg: auth.alg, signer: auth };
}

const contactOf = (p) => ({ [p.keyId]: { name: p.name, publicKey: p.publicKey, alg: p.alg } });

/** Ming asks, Stan gives. They have paired. Eve has paired with nobody. */
export async function makeWorld(options = {}) {
  const ming = await person("Ming", options.ming);
  const stan = await person("Stan");
  const eve = await person("Eve");
  return {
    ming,
    stan,
    eve,
    stanContacts: contactOf(ming),
    mingContacts: contactOf(stan),
    ledger: newLedger(),
  };
}

/** A mandate signed by Ming and a matching ask for 4,800. Override pieces to model attacks. */
export async function makeAsk(world, { mandate: mandateOverrides = {}, request: requestOverrides = {}, signer } = {}) {
  const { ming, stan } = world;
  const mandate = {
    ...buildMandate({
      principal: ming,
      agent: { name: "Ming's agent" },
      recipients: [stan],
      currency: "TWD",
      maxAmount: 4800,
      payee: MING_ACCOUNT,
      purpose: "Kenting guesthouse deposit",
    }),
    ...mandateOverrides,
  };
  const mandateEnvelope = await signPayload(mandate, signer ?? ming.signer);
  const request = {
    ...buildRequest({ mandate, from: ming, to: stan, amount: 4800, currency: "TWD", payee: MING_ACCOUNT, memo: "Kenting guesthouse deposit" }),
    ...requestOverrides,
  };
  return { mandate, mandateEnvelope, request, bundle: buildBundle({ request, mandateEnvelope }) };
}

export const failed = (verdict) => verdict.checks.filter((c) => !c.ok).map((c) => c.id);
