// Films the guided demo in headless Chrome, paced to a narration track.
// Usage: node e2e/record-video.mjs out.webm durations.json marks.json
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";

const [out, dursPath, marksPath] = process.argv.slice(2);
const durs = JSON.parse(readFileSync(dursPath, "utf8")).durs;
const base = process.env.BASE_URL ?? "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAD = 0.45; // silence before and after each narration segment, in seconds

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await page.goto(`${base}/app/demo.html?mode=sim&lang=${process.env.DEMO_LANG ?? "zh"}&auto=0&scene=intro`, { waitUntil: "networkidle0" });
await sleep(400);

const recorder = await page.screencast({ path: out });
const t0 = Date.now();
const marks = [];
const click = async (action) => {
  const sel = `[data-action="${action}"]:not([disabled])`;
  await page.waitForSelector(sel, { timeout: 8000 });
  await page.click(sel);
};
const reveal = (sel) => page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ behavior: "smooth", block: "center" }), sel);
async function seg(i, actions = async () => {}) {
  const start = Date.now();
  marks.push((start - t0) / 1000);
  const total = (durs[i] + PAD * 2) * 1000;
  const at = async (fraction) => {
    const wait = start + total * fraction - Date.now();
    if (wait > 0) await sleep(wait);
  };
  await actions(at);
  await at(1);
}

await seg(0);
await seg(1, () => page.click(".figure"));
await seg(2);
await seg(3, () => page.click(".figure"));
await seg(4, async (at) => { await click("start"); await at(0.25); await click("create-ming"); await at(0.45); await click("create-stan"); await at(0.65); await click("pair"); });
await seg(5, async (at) => { await click("start-act1"); await at(0.3); await reveal('[data-action="sign"]'); await at(0.68); await click("sign"); });
await seg(6, async (at) => { await reveal('[data-action="switch"]'); await at(0.1); await click("switch"); await at(0.4); await reveal('[data-action="pay"]'); await at(0.62); await click("pay"); });
await seg(7, async (at) => { await click("next"); await at(0.36); await click("try-forged"); await at(0.5); await reveal(".verdict"); });
await seg(8, async (at) => { await click("next"); await at(0.46); await click("send-altered"); await at(0.6); await reveal(".verdict"); });
await seg(9, () => page.click(".pip:last-child"));
await sleep(700);

const total = (Date.now() - t0) / 1000;
await recorder.stop();
await browser.close();
writeFileSync(marksPath, JSON.stringify({ marks, pad: PAD, total }));
console.log("recorded", total.toFixed(1), "s");
