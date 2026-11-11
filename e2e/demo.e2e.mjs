// Clicks through the whole demo in headless Chrome, once with simulated keys and once with
// real WebAuthn against Chrome's virtual authenticator. Run: npm run e2e  (needs npm i puppeteer-core)
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const base = process.env.BASE_URL ?? "http://localhost:8787";
const shots = new URL("./screenshots/", import.meta.url).pathname;
await mkdir(shots, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
let failures = 0;
const expect = (cond, label) => { console.log((cond ? "  ok   " : "  FAIL ") + label); if (!cond) failures++; };

for (const mode of ["sim", "passkey"]) {
  console.log(`\n== ${mode}`);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  if (mode === "passkey") {
    const cdp = await page.createCDPSession();
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  }
  const click = async (action) => { await page.waitForSelector(`[data-action="${action}"]:not([disabled])`, { timeout: 8000 }); await page.click(`[data-action="${action}"]`); };
  const verdict = async () => { await page.waitForSelector("[data-verdict]", { timeout: 8000 }); return page.$eval("[data-verdict]", (n) => [n.dataset.verdict, n.dataset.reason].join(":")); };
  const shot = (name) => page.screenshot({ path: `${shots}${mode}-${name}.png`, fullPage: true });

  await page.goto(`${base}/app/demo.html?mode=${mode}&lang=${mode === "sim" ? "zh" : "en"}&scene=setup`);
  await click("create-ming"); await click("create-stan"); await click("pair"); await shot("1-setup");
  expect((await page.$eval("[data-mode]", (n) => n.dataset.mode)) === mode, "mode is " + mode);
  await click("start-act1"); await shot("2-act1-draft");
  await click("sign"); await page.waitForSelector(".slip--stamped"); await new Promise((r) => setTimeout(r, 500)); await shot("3-act1-signed");
  await click("switch"); expect((await verdict()) === "pass:", "act 1: real ask passes"); await new Promise((r) => setTimeout(r, 900)); await shot("4-act1-verdict");
  await click("pay"); await page.waitForSelector("[data-receipt]"); await shot("5-act1-paid");
  await click("next");
  await click("try-none"); expect((await verdict()) === "block:has_mandate", "act 2: no mandate is blocked");
  await click("try-forged"); await page.waitForFunction(() => document.querySelector("[data-verdict]")?.dataset.reason === "principal_known", { timeout: 8000 }).catch(() => {});
  expect((await verdict()) === "block:principal_known", "act 2: forged mandate is blocked"); await new Promise((r) => setTimeout(r, 900)); await shot("6-act2-forged");
  await click("next"); await shot("7-act3-mail");
  await click("send-altered"); expect((await verdict()) === "block:amount_within_limit", "act 3: hijacked agent is blocked"); await new Promise((r) => setTimeout(r, 900)); await shot("8-act3-verdict");
  await click("next"); await click("ask-live"); await shot("9-act4-prompt");
  await click("confirm"); expect((await verdict()) === "pass:", "act 4: live confirmation passes"); await shot("10-act4-confirmed");
  await click("next"); await click("lab-run"); await page.waitForSelector("[data-score]");
  expect((await page.$eval("[data-score]", (n) => n.dataset.score)) === "4/4", "attack list: 4 of 4 blocked"); await new Promise((r) => setTimeout(r, 1200)); await shot("11-lab");
  await click("next"); await shot("12-end");
  expect(errors.length === 0, "no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await context.close();
}
await browser.close();
console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
