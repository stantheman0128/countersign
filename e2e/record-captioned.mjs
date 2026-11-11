// Films the guided demo in landscape with the narration script shown beside it, so a
// person can read the lines aloud while watching. Usage: node e2e/record-captioned.mjs out.webm
import puppeteer from "puppeteer-core";

const out = process.argv[2];
const base = process.env.BASE_URL ?? "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LINES = [
  "Every check you know verifies the person who pays.",
  "But a scam is a lie told by the person who asks. And AI can now fake a voice, a face, an account, even a friend's AI agent.",
  "Taiwan lost over 21 billion NT dollars to fraud in four months. Victims sent that money themselves.",
  "So the person who asks should sign too.",
  "Two people each create a key, and pair once.",
  "Ming's agent needs to collect a deposit from Stan. It can't sign, so Ming signs a mandate: who, how much, which account.",
  "Stan's phone checks the signature itself. All checks pass, he pays, and he signs too. That's the countersign.",
  "An impostor says the account changed. No signature from Ming, so it's blocked.",
  "Even Ming's own agent, hijacked by a malicious email, can't go past what Ming signed.",
  "One simple authorization step lets AI agents ask for you, and be believed. This is Countersign.",
];
const seconds = (text) => Math.max(3.2, text.split(/\s+/).length / 2.5 + 1.0);

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 844, deviceScaleFactor: 1.28 }); // 1920 x 1080 output
await page.goto(`${base}/app/demo.html?mode=sim&lang=en&auto=0&scene=intro`, { waitUntil: "networkidle0" });
await page.addStyleTag({
  content: `
    body { margin: 0 0 0 90px !important; }
    #cap { position: fixed; left: 650px; right: 70px; top: 50%; transform: translateY(-50%); color: #15233b; }
    #cap small { display: block; margin-bottom: 16px; font: 400 22px/1.2 sans-serif; color: #4a5a72; }
    #cap p { margin: 0; font: 600 42px/1.3 "Avenir Next", "Noto Sans CJK TC", "Noto Sans", sans-serif; }
    #capbar { height: 8px; margin-top: 30px; background: #fff; }
    #capbar i { display: block; height: 100%; width: 0; background: #d9301a; animation: capgrow linear forwards; }
    @keyframes capgrow { to { width: 100%; } }`,
});
const caption = (i, secs) =>
  page.evaluate(([n, total, text, secs]) => {
    let cap = document.getElementById("cap");
    if (!cap) { cap = document.createElement("div"); cap.id = "cap"; document.body.append(cap); }
    const small = document.createElement("small"); small.textContent = `Line ${n} of ${total}`;
    const p = document.createElement("p"); p.textContent = text;
    const bar = document.createElement("div"); bar.id = "capbar";
    const fill = document.createElement("i"); fill.style.animationDuration = secs + "s"; bar.append(fill);
    cap.replaceChildren(small, p, bar);
  }, [i + 1, LINES.length, LINES[i], secs]);

await sleep(300);
const recorder = await page.screencast({ path: out });
const click = async (action) => {
  const sel = `[data-action="${action}"]:not([disabled])`;
  await page.waitForSelector(sel, { timeout: 8000 });
  await page.click(sel);
};
const reveal = (sel) => page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ behavior: "smooth", block: "center" }), sel);
async function seg(i, actions = async () => {}) {
  const start = Date.now();
  const total = seconds(LINES[i]) * 1000;
  await caption(i, total / 1000 - 0.4);
  const at = async (fraction) => {
    const wait = start + total * fraction - Date.now();
    if (wait > 0) await sleep(wait);
  };
  await actions(at);
  await at(1);
}

const t0 = Date.now();
await seg(0);
await seg(1, () => page.click(".figure"));
await seg(2);
await seg(3, () => page.click(".figure"));
await seg(4, async (at) => { await click("start"); await at(0.25); await click("create-ming"); await at(0.45); await click("create-stan"); await at(0.65); await click("pair"); });
await seg(5, async (at) => { await click("start-act1"); await at(0.3); await reveal('[data-action="sign"]'); await at(0.66); await click("sign"); });
await seg(6, async (at) => { await reveal('[data-action="switch"]'); await at(0.1); await click("switch"); await at(0.4); await reveal('[data-action="pay"]'); await at(0.62); await click("pay"); });
await seg(7, async (at) => { await click("next"); await at(0.34); await click("try-forged"); await at(0.5); await reveal(".verdict"); });
await seg(8, async (at) => { await click("next"); await at(0.44); await click("send-altered"); await at(0.6); await reveal(".verdict"); });
await seg(9, () => page.click(".pip:last-child"));
await sleep(800);
console.log("recorded", ((Date.now() - t0) / 1000).toFixed(1), "s");
await recorder.stop();
await browser.close();
