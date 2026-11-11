# Countersign 雙簽

**An ask has to carry a real person's signature.**

Every check you meet today verifies the person who *pays*: Face ID before a transfer, a one-time code before a purchase. A scam is a lie told by the person who *asks*, and nothing verifies that side. AI makes the lie cheap (a cloned voice, a hijacked chat account), and AI agents remove the last free check: when "your friend's assistant" messages you, there is no voice to recognise at all.

Countersign is a small open format plus a reference implementation:

- A person signs a **mandate** on their own device with a passkey: who may be asked, up to how much, into which account, until when.
- Their agent carries that mandate when it asks. It cannot sign anything itself.
- The receiving side **verifies on its own device**: is this the key I paired with, did the device check a fingerprint or face, and is this ask inside what was signed?
- When the giver approves, they sign too. Both sides are on record for the same ask. That is the countersign.

> AP2 has the merchant sign the cart. Countersign has a *person* sign the ask.

## Try it

**Live demo (one phone plays both phones):** https://stantheman0128.github.io/countersign/

Real passkeys are used when the device supports them, so the Face ID or fingerprint prompt is the real one. Add `?mode=sim` to run with simulated keys, `?lang=zh` for Traditional Chinese.

```bash
npm test        # the attack list, as 26 tests (no dependencies)
npm start       # serve the demo at http://localhost:8787
```

## The demo in four acts

| Act | What happens | Result |
| --- | --- | --- |
| 1. A real ask | Ming tells his agent to collect a NT$4,800 deposit. He signs a mandate; the agent sends the request; Stan's phone checks it and Stan pays. | Passed, signed by both |
| 2. The impostor | "Ming's assistant" says the account changed. No mandate, or a mandate signed with the attacker's own key. | Blocked: not the Ming you paired with |
| 3. The hijacked agent | Ming's real agent reads an email with a hidden instruction and changes the account and amount. | Blocked: not what Ming signed |
| 4. Outside the mandate | The agent asks to borrow NT$100,000. Stan's phone asks Ming's own device to confirm that exact request. | Passed only if Ming's device says yes |

The agent's steps are scripted in the demo. Every signature and every check is real and runs in the browser.

## What a pass proves, and what it does not

It proves that a specific person's device signed this exact ask, after checking a fingerprint, face or PIN, and that the agent stayed inside it.

It does **not** prove that:

- the person wasn't tricked or forced into signing;
- a seller will deliver, or an investment is real (that needs escrow, not signatures);
- anything at all about someone you have not paired with.

Known gaps in this version: consumer passkeys can sync between a person's devices, so a production version should require a device-bound key; pairing is assumed to happen in person; payment is mocked.

## How it works

```
core/        format, canonical hashing, WebAuthn verification, the eleven checks  (no dependencies)
app/         the guided demo: passkeys in the browser, bilingual
test/        the attack list as tests
```

A mandate is canonical JSON. Its SHA-256 hash is the WebAuthn challenge, so the passkey signs exactly those bytes and changing one character breaks the signature. The receiver runs eleven checks (`core/rules.js`), each reported by name so the interface can say *why* something was blocked.

## Prior art

Web Bot Auth identifies which operator runs an agent. AP2 has merchants and shoppers sign carts. World's AgentKit proves some unique human stands behind an agent. Google's phone app verifies that a call from a contact comes from their device. Countersign covers a gap between them: one known person, asking another known person, through an agent.

---

## 中文摘要

現在的驗證都在驗「付錢的人」，但詐騙是「要錢的人」在說謊。Countersign 讓開口要的那一方也要帶著本人的簽章：本人用 passkey 簽一張委託（可以向誰要、上限多少、匯到哪個帳戶、到什麼時候），agent 帶著它去提出請求，收的那一方在自己的裝置上驗章。冒牌的拿不出簽章，真的 agent 被帶歪也越不過簽署的範圍。

它不解決「本人被騙去簽」、不解決「賣家不出貨」，也不適用於沒配對過的陌生人。

MIT License.
