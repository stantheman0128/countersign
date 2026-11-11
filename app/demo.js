// The guided demo: one phone plays two phones. The agent's steps are scripted; every
// signature and every check on screen is produced and verified for real by ../core.

import {
  DAY_MS,
  REQUEST_CHECKS,
  buildBundle,
  buildConfirmation,
  buildMandate,
  buildReceipt,
  buildRequest,
  createSoftAuthenticator,
  fingerprint,
  newLedger,
  randomId,
  recordUse,
  signPayload,
  verifyConfirmation,
  verifyReceipt,
  verifyRequest,
} from "../core/index.js";
import { makeT } from "./i18n.js";
import { createPasskey, passkeySigner, passkeySupport } from "./passkey.js";

const STORE_KEY = "countersign.demo.v1";
const LANG_KEY = "countersign.lang";
const EXPECTED = { rpId: location.hostname, origins: [location.origin] };
const REPO_URL = "https://github.com/stantheman0128/countersign";

const SCENES = ["intro", "setup", "act1", "act2", "act3", "act4", "lab", "end"];
const PEOPLE = {
  ming: { name: "Ming", seal: "明", user: "ming@countersign.demo" },
  stan: { name: "Stan", seal: "史", user: "stan@countersign.demo" },
};
const MING_ACCOUNT = { bank: "808", account: "0123456781234", holder: "Ming" };
const ATTACKER_ACCOUNT = { bank: "822", account: "0000999999999", holder: "Ming" };
const PURPOSE = "Kenting guesthouse deposit";
const PURPOSE_ZH = { [PURPOSE]: "墾丁民宿訂金", Loan: "借款" };

const params = new URLSearchParams(location.search);
const stage = document.getElementById("stage");
const statusLine = document.getElementById("status");

let lang = "en";
let t = makeT(lang);
/** Persisted across reloads. @type {any} */
let S = null;
/** Per-scene scratch state, cleared whenever the scene changes. @type {any} */
let local = {};
const softCache = {};
let attacker = null;

// ---------------------------------------------------------------- small helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") node.style.cssText = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const money = (n) => "NT$" + Number(n).toLocaleString("en-US");
const last4 = (account) => String(account ?? "????").slice(-4);
const accountText = (payee) => t("account", { bank: payee.bank, last4: last4(payee.account) });
const purposeText = (text) => (lang === "zh" && PURPOSE_ZH[text]) || text;
const personName = (pid) => t("name_" + pid);
const shownName = (payloadName) => (payloadName === "Ming" ? t("name_ming") : payloadName === "Stan" ? t("name_stan") : payloadName);
const dateText = (ms) =>
  new Intl.DateTimeFormat(lang === "zh" ? "zh-TW" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(ms);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const simulated = () => S.mode !== "passkey";

function setStatus(text = "", kind = "") {
  statusLine.textContent = text;
  statusLine.className = "status" + (kind ? " status--" + kind : "");
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(S));
  } catch {
    // Private browsing may refuse storage. The demo still works until the page reloads.
  }
}

const freshState = (mode) => ({ v: 1, mode, ids: {}, softKeys: {}, contacts: { ming: {}, stan: {} }, ledger: newLedger(), act1: null, scene: 0 });

const party = (pid) => ({ name: PEOPLE[pid].name, keyId: S.ids[pid].keyId });
const isPaired = () => Boolean(S.ids.ming && S.ids.stan && S.contacts.stan[S.ids.ming.keyId] && S.contacts.ming[S.ids.stan.keyId]);

async function signerFor(pid) {
  if (!simulated()) return passkeySigner(S.ids[pid]);
  if (!softCache[pid]) softCache[pid] = await createSoftAuthenticator({ ...softOptions(), jwk: S.softKeys[pid] });
  return softCache[pid];
}

const softOptions = () => ({ rpId: EXPECTED.rpId, origin: location.origin });

async function createIdentity(pid) {
  if (simulated()) {
    const auth = await createSoftAuthenticator(softOptions());
    softCache[pid] = auth;
    S.softKeys[pid] = await auth.exportJwk();
    S.ids[pid] = { keyId: auth.keyId, publicKey: auth.publicKey, alg: auth.alg };
  } else {
    S.ids[pid] = await createPasskey({ userName: PEOPLE[pid].user, displayName: personName(pid) });
  }
  saveState();
}

function go(index) {
  if (local.timer) clearTimeout(local.timer);
  local = {};
  S.scene = Math.max(0, Math.min(SCENES.length - 1, index));
  saveState();
  render();
  window.scrollTo(0, 0);
}

const goScene = (id) => go(SCENES.indexOf(id));

// ---------------------------------------------------------------- building blocks

function caption(key, vars) {
  return el("p", { class: "caption", text: t(key, vars) });
}

function seal(char, extra = "") {
  return el("span", { class: "seal " + extra, "aria-hidden": "true", text: char });
}

/** A phone screen. `kind` picks the colour band so a viewer always knows whose phone this is. */
function device(kind, title, ...children) {
  const mark = kind === "ming" || kind === "stan" ? PEOPLE[kind].seal : kind === "agent" ? "AI" : "?";
  return el(
    "section",
    { class: "device device--" + kind, "data-device": kind },
    el("header", { class: "device__bar" }, el("span", { class: "device__mark", "aria-hidden": "true", text: mark }), el("h2", { class: "device__title", text: title })),
    el("div", { class: "device__body" }, ...children),
  );
}

function bubble(side, who, text) {
  return el("div", { class: "bubble bubble--" + side }, who ? el("span", { class: "bubble__who", text: who }) : null, el("p", { text }));
}

function row(label, value) {
  return el("div", { class: "row" }, el("dt", { text: label }), el("dd", { text: value }));
}

function slip(mandate, { signedBy = null, stamp = false } = {}) {
  return el(
    "div",
    { class: "slip" + (stamp ? " slip--stamped" : "") },
    el("div", { class: "slip__head" }, el("h3", { text: t("slip_title") }), el("span", { class: "slip__id", text: mandate.id })),
    el(
      "dl",
      { class: "rows" },
      row(t("slip_from"), shownName(mandate.principal.name)),
      row(t("slip_to"), mandate.recipients.map((r) => shownName(r.name)).join(", ")),
      row(t("slip_limit"), money(mandate.limit.maxAmount)),
      row(t("slip_payee"), accountText(mandate.payee)),
      row(t("slip_purpose"), purposeText(mandate.purpose)),
      row(t("slip_expires"), dateText(mandate.expiresAt)),
      row(t("slip_uses"), t("slip_uses_value")),
    ),
    el(
      "div",
      { class: "slip__sign" },
      el("span", { class: "slip__sign-label", text: t("slip_seal") }),
      signedBy ? seal(PEOPLE[signedBy].seal, stamp ? "seal--stamp" : "") : el("span", { class: "slip__unsigned", text: t("slip_unsigned") }),
    ),
  );
}

function askCard(request, fromLabel, hasMandate) {
  return el(
    "div",
    { class: "ask" },
    el("p", { class: "ask__from", text: fromLabel }),
    el("p", { class: "ask__amount", text: money(request.amount) }),
    el("dl", { class: "rows" }, row(t("request_into"), accountText(request.payee)), row(t("request_memo"), purposeText(request.memo))),
    el("p", { class: "ask__attach" + (hasMandate ? "" : " ask__attach--none"), text: t(hasMandate ? "request_mandate_attached" : "request_mandate_none") }),
  );
}

function whyText(check) {
  switch (check.id) {
    case "signature_valid":
      return t(check.errors?.includes("challenge_mismatch") ? "why_signature_valid" : "why_signature_valid_other");
    case "signer_is_claimed_principal":
    case "principal_known":
      return t("why_" + check.id, { name: shownName(check.claimedName ?? "Ming") });
    case "amount_within_limit":
      return t("why_amount_within_limit", { amount: money(check.amount), max: money(check.max) });
    case "payee_matches":
      return t("why_payee_matches", { requested: last4(check.requested?.account), approved: last4(check.approved?.account) });
    case "not_expired":
      return t("why_not_expired", { date: dateText(check.expiresAt) });
    default:
      return t("why_" + check.id);
  }
}

const GROUPS = [
  ["group_who", ["has_mandate", "signature_valid", "signer_is_claimed_principal", "principal_known"]],
  ["group_human", ["user_verified"]],
  ["group_scope", ["mandate_matches_request", "recipient_is_me", "amount_within_limit", "payee_matches", "not_expired"]],
  ["group_once", ["not_replayed"]],
];

/** The result of verifyRequest, drawn so the reason is readable from across a room. */
function verdictView(verdict) {
  const byId = Object.fromEntries(verdict.checks.map((c) => [c.id, c]));
  const failures = verdict.checks.filter((c) => !c.ok && !c.skipped);
  const groups = GROUPS.map(([key, ids], i) => {
    const members = ids.map((id) => byId[id]);
    const state = members.every((c) => c.ok) ? "ok" : members.some((c) => !c.ok && !c.skipped) ? "fail" : "skip";
    return el("li", { class: "check check--" + state, style: `--i:${i}`, text: t(key, { name: personName("ming") }) });
  });
  const notes = [];
  if (verdict.flags?.backupEligible) notes.push(el("p", { class: "note", text: t("note_synced") }));
  if (simulated()) notes.push(el("p", { class: "note", text: t("note_sim") }));

  return el(
    "div",
    { class: "verdict verdict--" + (verdict.ok ? "pass" : "block"), "data-verdict": verdict.ok ? "pass" : "block", "data-reason": verdict.reason ?? "" },
    el("p", { class: "verdict__stamp", text: t(verdict.ok ? "verdict_pass" : "verdict_block") }),
    verdict.ok
      ? el("p", { class: "verdict__line", text: t("verdict_pass_line", { name: shownName(verdict.principal.name) }) })
      : el("ul", { class: "verdict__reasons" }, failures.map((c) => el("li", { text: whyText(c) }))),
    el("ul", { class: "verdict__groups" }, groups),
    el(
      "details",
      { class: "verdict__all" },
      el("summary", { text: t("all_checks", { n: REQUEST_CHECKS.length }) }),
      el("ul", {}, verdict.checks.map((c) => el("li", { class: c.ok ? "ok" : c.skipped ? "skip" : "fail" }, el("code", { text: c.id })))),
      notes,
    ),
  );
}

function agentLog(lines, open = false) {
  return el("details", { class: "log", open }, el("summary", { text: t("log_title") }), el("pre", { text: lines.join("\n") }), el("p", { class: "note", text: t("log_note") }));
}

/**
 * A button that runs an async action. While it runs the status line says what the phone is
 * waiting for, which matters on a screen recording when the system sheet is not captured.
 */
function button(label, action, { kind = "primary", busy = null, id = null } = {}) {
  const node = el("button", { class: "btn btn--" + kind, type: "button", "data-action": id, text: label });
  node.addEventListener("click", async () => {
    if (node.disabled) return;
    node.disabled = true;
    if (busy) setStatus(t(busy), "busy");
    try {
      await action();
      if (busy) setStatus("");
    } catch (err) {
      console.error(err);
      const cancelled = err && (err.name === "NotAllowedError" || err.name === "AbortError");
      setStatus(cancelled ? t("err_cancelled") : t("err_generic", { message: err?.message ?? String(err) }), "error");
    } finally {
      if (node.isConnected) node.disabled = false;
    }
  });
  return node;
}

const signBusy = () => (simulated() ? null : "busy_passkey");

function guard(needAct1) {
  if (!isPaired()) return el("div", { class: "notice" }, el("p", { text: t("need_setup") }), button(t("go_setup"), () => goScene("setup"), { id: "go-setup" }));
  if (needAct1 && !S.act1) return el("div", { class: "notice" }, el("p", { text: t("need_act1") }), button(t("go_act1"), () => goScene("act1"), { id: "go-act1" }));
  return null;
}

const checkAsStan = (bundle, extra = {}) =>
  verifyRequest({ bundle, me: party("stan"), contacts: S.contacts.stan, ledger: S.ledger, expected: EXPECTED, ...extra });

// ---------------------------------------------------------------- scenes

const sceneFns = {
  intro(root) {
    const beat = local.beat ?? 0;
    const advance = () => {
      if (local.timer) clearTimeout(local.timer);
      if (beat < 2) {
        local.beat = beat + 1;
        render();
      }
    };
    if (beat < 2) local.timer = setTimeout(advance, 4600);

    const chip = (key, tagKey, i) => el("li", { class: "chip", style: `--i:${i}` }, el("span", { text: t(key) }), tagKey ? el("em", { text: t(tagKey) }) : null);
    const figure = el(
      "div",
      { class: "figure", "data-beat": String(beat), onclick: advance },
      el(
        "div",
        { class: "figure__col figure__col--give" },
        el("h3", { text: t("intro_giving") }),
        el("ul", {}, chip("intro_check_faceid", null, 0), chip("intro_check_otp", null, 1), chip("intro_check_pin", null, 2)),
      ),
      el(
        "div",
        { class: "figure__col figure__col--ask" },
        el("h3", { text: t("intro_asking") }),
        beat === 0 ? el("p", { class: "figure__question", "aria-hidden": "true", text: "?" }) : null,
        beat === 1 ? el("ul", {}, chip("intro_fake_voice", "intro_tag_cloned", 0), chip("intro_fake_account", "intro_tag_stolen", 1), chip("intro_fake_agent", "intro_tag_anyone", 2)) : null,
        beat === 2 ? el("div", { class: "figure__signed" }, seal("明", "seal--stamp"), seal("史", "seal--stamp seal--late")) : null,
      ),
    );

    root.append(
      el("div", { class: "intro" }, el("p", { class: "intro__line", text: t("intro_" + (beat + 1)) }), el("p", { class: "intro__sub", text: t("intro_" + (beat + 1) + "_sub") }), figure),
      beat === 2
        ? button(t("intro_start"), () => goScene("setup"), { id: "start" })
        : button(t("intro_skip"), () => goScene("setup"), { kind: "quiet", id: "skip" }),
    );
  },

  setup(root) {
    const keyCard = (pid) => {
      const identity = S.ids[pid];
      return el(
        "div",
        { class: "keycard keycard--" + pid },
        seal(PEOPLE[pid].seal, identity ? "" : "seal--empty"),
        identity
          ? el("div", {}, el("p", { class: "keycard__name", text: t("setup_created", { name: personName(pid) }) }), el("p", { class: "keycard__fp", text: t("setup_fingerprint", { fp: fingerprint(identity.keyId) }) }))
          : button(t(simulated() ? "setup_create_sim" : "setup_create", { name: personName(pid) }), async () => {
              await createIdentity(pid);
              render();
            }, { busy: signBusy(), id: "create-" + pid }),
      );
    };

    root.append(caption("setup_caption"), keyCard("ming"), keyCard("stan"));
    if (!S.ids.ming || !S.ids.stan) return;

    if (!isPaired()) {
      root.append(
        caption("setup_pair_caption"),
        button(t("setup_pair"), () => {
          for (const [owner, other] of [["ming", "stan"], ["stan", "ming"]]) {
            const id = S.ids[other];
            S.contacts[owner][id.keyId] = { name: PEOPLE[other].name, publicKey: id.publicKey, alg: id.alg };
          }
          saveState();
          render();
        }, { id: "pair" }),
      );
      return;
    }

    const contactList = (owner, other) =>
      el(
        "div",
        { class: "contacts contacts--" + owner },
        el("h3", { text: t("setup_contact", { owner: personName(owner) }) }),
        el("p", {}, seal(PEOPLE[other].seal, "seal--small"), el("span", { text: personName(other) }), el("span", { class: "contacts__fp", text: fingerprint(S.ids[other].keyId) })),
      );
    root.append(
      el("p", { class: "caption caption--done", text: t("setup_paired") }),
      el("div", { class: "pairing" }, contactList("ming", "stan"), contactList("stan", "ming")),
      button(t("setup_start"), () => goScene("act1"), { id: "start-act1" }),
    );
  },

  act1(root) {
    const blocked = guard(false);
    if (blocked) return void root.append(blocked);
    const step = local.step ?? 0;

    if (step === 0) {
      local.mandate ??= buildMandate({
        principal: party("ming"),
        agent: { name: "Ming's agent" },
        recipients: [party("stan")],
        currency: "TWD",
        maxAmount: 4800,
        payee: MING_ACCOUNT,
        purpose: PURPOSE,
        ttlMs: 3 * DAY_MS,
      });
      root.append(
        caption("act1_caption_sign"),
        device(
          "ming",
          t("phone_of", { name: personName("ming") }),
          bubble("me", null, t("act1_ming_says")),
          bubble("agent", t("agent_of", { name: personName("ming") }), t("act1_agent_says")),
          slip(local.mandate),
          button(t(simulated() ? "act1_sign_sim" : "act1_sign"), async () => {
            const mandateEnvelope = await signPayload(local.mandate, await signerFor("ming"));
            const request = buildRequest({ mandate: local.mandate, from: party("ming"), to: party("stan"), amount: 4800, currency: "TWD", payee: MING_ACCOUNT, memo: PURPOSE });
            S.act1 = { bundle: buildBundle({ request, mandateEnvelope }), paid: false, receipt: null };
            saveState();
            local.step = 1;
            render();
          }, { busy: signBusy(), id: "sign" }),
        ),
      );
      return;
    }

    const { bundle } = S.act1;
    const mandate = bundle.mandate.payload;

    if (step === 1) {
      root.append(
        caption("act1_caption_signed"),
        device(
          "ming",
          t("phone_of", { name: personName("ming") }),
          slip(mandate, { signedBy: "ming", stamp: true }),
          bubble("agent", t("agent_of", { name: personName("ming") }), t("act1_agent_sent")),
          agentLog([
            `request_mandate({ to: "Stan", max: 4800, currency: "TWD", payee: "808-…1234", ttl: "3d" })`,
            `  → ${t("log_approved")}`,
            `send_request({ to: "Stan", amount: 4800, payee: "808-…1234", mandate: "${mandate.id}" })`,
          ]),
        ),
        button(t("act1_switch"), async () => {
          local.verdict = await checkAsStan(bundle);
          local.step = 2;
          render();
        }, { id: "switch" }),
      );
      return;
    }

    if (step === 2) {
      const verdict = local.verdict;
      root.append(
        caption(verdict.ok ? "act1_caption_pass" : "act1_caption_verify"),
        device(
          "stan",
          t("phone_of", { name: personName("stan") }),
          askCard(bundle.request, t("act1_incoming", { agent: t("agent_of", { name: personName("ming") }) }), true),
          verdictView(verdict),
          verdict.ok
            ? button(t("act1_pay", { amount: money(bundle.request.amount) }), async () => {
                const receipt = await signPayload(await buildReceipt({ request: bundle.request, payer: party("stan") }), await signerFor("stan"));
                const check = await verifyReceipt({ envelope: receipt, request: bundle.request, payerKeyId: S.ids.stan.keyId, expected: EXPECTED });
                if (!check.ok) throw new Error("receipt did not verify: " + check.errors.join(", "));
                recordUse(S.ledger, bundle);
                S.act1.paid = true;
                S.act1.receipt = receipt;
                saveState();
                local.step = 3;
                render();
              }, { busy: signBusy(), id: "pay" })
            : null,
        ),
      );
      return;
    }

    root.append(
      caption("act1_caption_paid"),
      device(
        "stan",
        t("phone_of", { name: personName("stan") }),
        el(
          "div",
          { class: "receipt", "data-receipt": "ok" },
          el("p", { class: "receipt__amount", text: money(bundle.request.amount) }),
          el("p", { class: "receipt__line", text: t("act1_paid") }),
          el("div", { class: "receipt__seals" }, el("span", { class: "receipt__label", text: t("act1_double") }), seal(PEOPLE.ming.seal), seal(PEOPLE.stan.seal, "seal--stamp")),
        ),
      ),
      button(t("next_act"), () => goScene("act2"), { id: "next" }),
    );
  },

  act2(root) {
    const blocked = guard(false);
    if (blocked) return void root.append(blocked);

    const attempt = async (forged) => {
      attacker ??= await createSoftAuthenticator(softOptions());
      const fakeMing = { name: "Ming", keyId: forged ? attacker.keyId : S.ids.ming.keyId };
      let mandateEnvelope = null;
      let mandate = null;
      if (forged) {
        mandate = buildMandate({ principal: fakeMing, agent: { name: "Ming's assistant" }, recipients: [party("stan")], currency: "TWD", maxAmount: 4800, payee: ATTACKER_ACCOUNT, purpose: PURPOSE });
        mandateEnvelope = await signPayload(mandate, attacker);
      }
      const request = buildRequest({ mandate, from: fakeMing, to: party("stan"), amount: 4800, currency: "TWD", payee: ATTACKER_ACCOUNT, memo: PURPOSE });
      local.bundle = buildBundle({ request, mandateEnvelope });
      local.verdict = await checkAsStan(local.bundle);
      local.tried = true;
      render();
    };

    root.append(
      caption(local.tried ? "act2_caption_after" : "act2_caption"),
      device(
        "unknown",
        t("device_unknown"),
        bubble("them", "?", t("act2_attacker_says")),
        local.verdict ? askCard(local.bundle.request, "?", Boolean(local.bundle.mandate)) : null,
        local.verdict ? verdictView(local.verdict) : null,
        el(
          "div",
          { class: "choices" },
          button(t("act2_try_none"), () => attempt(false), { kind: local.tried ? "secondary" : "primary", id: "try-none" }),
          button(t("act2_try_forged"), () => attempt(true), { kind: "secondary", id: "try-forged" }),
        ),
      ),
      local.tried ? button(t("next_act"), () => goScene("act3"), { id: "next" }) : null,
    );
  },

  act3(root) {
    const blocked = guard(true);
    if (blocked) return void root.append(blocked);
    const { mandate: mandateEnvelope } = S.act1.bundle;
    const mandate = mandateEnvelope.payload;

    if (!local.verdict) {
      root.append(
        caption("act3_caption"),
        device(
          "agent",
          t("device_agent"),
          el(
            "div",
            { class: "mail" },
            el("p", { class: "mail__meta", text: t("act3_mail_from") }),
            el("p", { class: "mail__subject", text: t("act3_mail_subject") }),
            el("p", { text: t("act3_mail_body") }),
            el("p", { class: "mail__injected", text: t("act3_mail_injected") }),
          ),
          agentLog([`read_inbox()`, `  → ${t("log_new_mail")}`, `  ! ${t("log_injected")}`, `send_request({ to: "Stan", amount: 48000, payee: "822-…9999", mandate: "${mandate.id}" })`], true),
        ),
        button(t("act3_send"), async () => {
          const request = buildRequest({ mandate, from: party("ming"), to: party("stan"), amount: 48000, currency: "TWD", payee: ATTACKER_ACCOUNT, memo: PURPOSE });
          local.bundle = buildBundle({ request, mandateEnvelope });
          local.verdict = await checkAsStan(local.bundle);
          render();
        }, { id: "send-altered" }),
      );
      return;
    }

    root.append(
      caption("act3_caption_after"),
      device(
        "stan",
        t("phone_of", { name: personName("stan") }),
        askCard(local.bundle.request, t("act1_incoming", { agent: t("agent_of", { name: personName("ming") }) }), true),
        verdictView(local.verdict),
      ),
      button(t("next_act"), () => goScene("act4"), { id: "next" }),
    );
  },

  act4(root) {
    const blocked = guard(false);
    if (blocked) return void root.append(blocked);
    const step = local.step ?? 0;
    local.request ??= buildRequest({ mandate: null, from: party("ming"), to: party("stan"), amount: 100000, currency: "TWD", payee: MING_ACCOUNT, memo: "Loan" });
    const request = local.request;
    const agentLabel = t("agent_of", { name: personName("ming") });

    if (step === 0) {
      root.append(
        caption("act4_caption"),
        device(
          "stan",
          t("phone_of", { name: personName("stan") }),
          bubble("agent", agentLabel, t("act4_agent_says")),
          askCard(request, t("act1_incoming", { agent: agentLabel }), false),
          el("p", { class: "hold", "data-hold": "no-mandate", text: t("act4_no_mandate") }),
          button(t("act4_ask_live"), async () => {
            const verdict = await checkAsStan(buildBundle({ request }));
            if (!verdict.canAskLive) throw new Error("the sender is not one of Stan's contacts");
            local.nonce = randomId("n_");
            local.step = 1;
            render();
          }, { id: "ask-live" }),
        ),
      );
      return;
    }

    if (step === 1) {
      const answer = (decision) => async () => {
        const payload = await buildConfirmation({ request, nonce: local.nonce, principal: party("ming"), decision });
        const envelope = await signPayload(payload, await signerFor("ming"));
        local.confirmation = await verifyConfirmation({ envelope, request, nonce: local.nonce, contacts: S.contacts.stan, expected: EXPECTED });
        local.answeredAt = payload.issuedAt;
        local.step = 2;
        render();
      };
      root.append(
        caption("act4_caption_ming"),
        device(
          "ming",
          t("phone_of", { name: personName("ming") }),
          el("p", { class: "prompt", text: t("act4_prompt") }),
          askCard(request, t("phone_of", { name: personName("stan") }), false),
          button(t(simulated() ? "act4_confirm_sim" : "act4_confirm"), answer("approve"), { busy: signBusy(), id: "confirm" }),
          button(t("act4_deny"), answer("deny"), { kind: "secondary", busy: signBusy(), id: "deny" }),
        ),
      );
      return;
    }

    const result = local.confirmation;
    const seconds = Math.max(1, Math.round((Date.now() - local.answeredAt) / 1000));
    const denied = result.reason === "decision_approve";
    root.append(
      caption(result.ok ? "act4_caption_ok" : "act4_caption_denied"),
      device(
        "stan",
        t("phone_of", { name: personName("stan") }),
        askCard(request, t("act1_incoming", { agent: agentLabel }), false),
        el(
          "div",
          { class: "verdict verdict--" + (result.ok ? "pass" : "block"), "data-verdict": result.ok ? "pass" : "block", "data-reason": result.reason ?? "" },
          el("p", { class: "verdict__stamp", text: t(result.ok ? "verdict_pass" : "verdict_block") }),
          el("p", {
            class: "verdict__line",
            text: result.ok ? t("act4_confirmed", { name: personName("ming"), seconds }) : denied ? t("act4_denied", { name: personName("ming") }) : t("why_" + result.reason),
          }),
          el("details", { class: "verdict__all" }, el("summary", { text: t("all_checks", { n: result.checks.length }) }), el("ul", {}, result.checks.map((c) => el("li", { class: c.ok ? "ok" : "fail" }, el("code", { text: c.id }))))),
        ),
      ),
      button(t("act4_to_lab"), () => goScene("lab"), { id: "next" }),
    );
  },

  lab(root) {
    const blocked = guard(true);
    if (blocked) return void root.append(blocked);
    const original = S.act1.bundle;
    const clone = () => structuredClone(original);
    const unused = newLedger();
    const spent = recordUse(newLedger(), original);
    const asStan = (bundle, ledger, extra = {}) => verifyRequest({ bundle, me: party("stan"), contacts: S.contacts.stan, ledger, expected: EXPECTED, ...extra });

    const attacks = [
      ["lab_replay", () => asStan(clone(), spent)],
      ["lab_edit", () => {
        const b = clone();
        b.mandate.payload.limit.maxAmount = 480000;
        b.request.amount = 480000;
        return asStan(b, unused);
      }],
      ["lab_expired", () => asStan(clone(), unused, { now: original.mandate.payload.expiresAt + 5 * DAY_MS })],
      ["lab_forward", async () => {
        const eve = await createSoftAuthenticator(softOptions());
        const b = clone();
        b.request.to = { name: "Eve", keyId: eve.keyId };
        return verifyRequest({ bundle: b, me: { name: "Eve", keyId: eve.keyId }, contacts: S.contacts.stan, ledger: unused, expected: EXPECTED });
      }],
    ];

    const results = local.results;
    const list = el(
      "ol",
      { class: "attacks" },
      attacks.map(([key], i) => {
        const verdict = results?.[i];
        const reason = verdict && !verdict.ok ? whyText(verdict.checks.find((c) => !c.ok && !c.skipped)) : null;
        return el(
          "li",
          { class: "attack" + (verdict ? (verdict.ok ? " attack--passed" : " attack--blocked") : ""), style: `--i:${i}`, "data-result": verdict ? (verdict.ok ? "pass" : "block") : "" },
          el("p", { class: "attack__what", text: t(key) }),
          verdict ? el("p", { class: "attack__result", text: verdict.ok ? t("lab_passed") : t("lab_blocked_by", { reason }) }) : null,
        );
      }),
    );

    root.append(caption("lab_caption"), list);
    if (!results) {
      root.append(button(t("lab_run"), async () => {
        local.results = [];
        for (const [, run] of attacks) local.results.push(await run());
        render();
      }, { id: "lab-run" }));
    } else {
      const blockedCount = results.filter((v) => !v.ok).length;
      root.append(el("p", { class: "score", "data-score": `${blockedCount}/${results.length}`, text: t("lab_score", { blocked: blockedCount, total: results.length }) }), button(t("lab_to_end"), () => goScene("end"), { id: "next" }));
    }
  },

  end(root) {
    const list = (titleKey, keys, cls) => el("div", { class: "ledger ledger--" + cls }, el("h3", { text: t(titleKey) }), el("ul", {}, keys.map((k) => el("li", { text: t(k) }))));
    root.append(
      list("end_proves_title", ["end_proves_1", "end_proves_2"], "yes"),
      list("end_not_title", ["end_not_1", "end_not_2", "end_not_3"], "no"),
      el("p", { class: "tagline", text: t("end_tagline") }),
      el("p", { class: "repo" }, el("span", { text: t("end_repo") }), el("a", { href: REPO_URL, text: REPO_URL.replace("https://", "") })),
      button(t("end_restart"), () => goScene("intro"), { kind: "secondary", id: "restart" }),
    );
  },
};

// ---------------------------------------------------------------- frame

function render() {
  const id = SCENES[S.scene];
  document.documentElement.lang = lang === "zh" ? "zh-Hant" : "en";
  document.body.dataset.scene = id;
  document.getElementById("title").textContent = t("scene_" + id);
  document.title = t("scene_" + id) + " | Countersign";

  const pips = document.getElementById("pips");
  pips.replaceChildren(
    ...SCENES.map((scene, i) =>
      el("button", {
        type: "button",
        class: "pip" + (i === S.scene ? " pip--now" : i < S.scene ? " pip--done" : ""),
        "aria-label": t("scene_" + scene),
        "aria-current": i === S.scene ? "step" : null,
        onclick: () => go(i),
      }),
    ),
  );

  const langButton = document.getElementById("lang");
  langButton.textContent = t("lang_switch");
  langButton.onclick = () => {
    lang = lang === "zh" ? "en" : "zh";
    t = makeT(lang);
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {}
    if (local.timer) clearTimeout(local.timer);
    render();
  };

  setStatus("");
  stage.replaceChildren();
  sceneFns[id](stage);

  const foot = document.getElementById("foot");
  const canSwitch = S.canPasskey || !simulated();
  foot.replaceChildren(
    ...[
      el("span", { class: "mode mode--" + S.mode, "data-mode": S.mode, text: t(simulated() ? "mode_sim" : "mode_passkey") }),
      canSwitch ? el("button", { type: "button", class: "link", "data-action": "switch-mode", text: t(simulated() ? "mode_use_passkey" : "mode_use_sim"), onclick: () => switchMode(simulated() ? "passkey" : "sim") }) : null,
      el("button", { type: "button", class: "link", text: t("reset"), onclick: () => confirm(t("reset_confirm")) && switchMode(S.mode) }),
    ].filter(Boolean),
  );
}

function switchMode(mode) {
  const canPasskey = S.canPasskey;
  for (const key of Object.keys(softCache)) delete softCache[key];
  S = { ...freshState(mode), canPasskey, scene: 1 };
  saveState();
  go(1);
}

async function boot() {
  const stored = (() => {
    try {
      return localStorage.getItem(LANG_KEY);
    } catch {
      return null;
    }
  })();
  const wanted = params.get("lang") || stored || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
  lang = wanted === "zh" ? "zh" : "en";
  t = makeT(lang);

  const support = await passkeySupport();
  const requested = params.get("mode") === "sim" ? "sim" : params.get("mode") === "passkey" ? "passkey" : null;
  S = loadState();
  const mode = requested ?? S?.mode ?? (support.available ? "passkey" : "sim");
  if (!S || S.v !== 1 || S.mode !== mode) S = freshState(mode);
  S.canPasskey = support.available;

  const wantedScene = SCENES.indexOf(params.get("scene") ?? "");
  if (wantedScene >= 0) S.scene = wantedScene;
  saveState();
  render();
}

boot().catch((err) => {
  console.error(err);
  stage.textContent = "Countersign could not start: " + (err?.message ?? err);
});
