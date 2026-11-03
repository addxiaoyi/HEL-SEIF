
import { chromium } from "playwright";
import { demoSnapshot } from "../electron/services/demo.mjs";

const billing = { amount: 89, currency: "CNY", cycle: "year" };
const now = Date.now();
const day = (n) => new Date(now + n * 86400000).toISOString().slice(0, 10);
const demo = demoSnapshot();
const plain = (item, extra) => ({
  ...item,
  demo: undefined,
  tags: ["tidy"],
  notes: "",
  ...extra,
});
const snapshot = {
  servers: [
    plain(demo.servers[0], {
      id: "srv-tidy-1",
      name: "tidy-one",
      label: "tidy-one",
      host: "203.0.113.9",
      status: "online",
      expiresAt: day(12),
      billing: undefined,
      probeError: undefined,
    }),
    plain(demo.servers[2], {
      id: "srv-tidy-2",
      name: "tidy-two",
      label: "tidy-two",
      host: "203.0.113.10",
      status: "offline",
      expiresAt: undefined,
      billing,
      probeError: "connect refused",
    }),
  ],
  domains: [
    plain(demo.domains[0], {
      id: "dom-tidy-1",
      name: "tidy-domain.test",
      expiresAt: day(-4),
      billing,
    }),
  ],
  mailboxes: [
    plain(demo.mailboxes[0], {
      id: "mail-tidy-1",
      address: "tidy@example.com",
      usedMb: 860,
      quotaMb: 1000,
    }),
  ],
  aiAssets: [
    plain(demo.aiAssets[0], {
      id: "ai-tidy-1",
      name: "Tidy AI",
      renewsAt: day(6),
      subscriptionExpiresAt: null,
      monthlyUsdKnown: false,
    }),
  ],
  certs: [
    plain(demo.certs[0], {
      id: "cert-tidy-1",
      cn: "tidy-domain.test",
      expiresAt: day(9),
      status: "warning",
    }),
  ],
  phoneNumbers: [],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.evaluate((snap) => {
  const current = JSON.parse(localStorage.getItem("sinan-assets-v1") ?? "{}");
  localStorage.setItem(
    "sinan-assets-v1",
    JSON.stringify({ ...current, state: { ...current.state, ...snap } }),
  );
}, snapshot);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2000);
await page.screenshot({ path: "screenshots/tidy-overview.png", animations: "disabled" });
await page.getByRole("button", { name: "AI 助手" }).first().click({ timeout: 8000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: "screenshots/tidy-agent.png", animations: "disabled" });
const info = { hasTidy: (await page.locator(".agent-tidy").count()) > 0 };
if (info.hasTidy) {
  info.tidy = (await page.locator(".agent-tidy").innerText()).replace(/\s+/g, " ");
  await page.locator(".agent-tidy-chip").nth(2).click();
  await page.waitForTimeout(400);
  info.groupDraft = await page.locator("textarea.agent-input").inputValue();
  await page.locator(".agent-tidy-run").click();
  await page.waitForTimeout(400);
  info.allDraft = await page.locator("textarea.agent-input").inputValue();
  info.changesChecked = await page.evaluate(() => {
    const label = [...document.querySelectorAll(".agent-permissions label")].find((node) =>
      node.textContent.includes("本次生成修改建议"),
    );
    return label ? label.querySelector("input").checked : null;
  });
  await page.screenshot({ path: "screenshots/tidy-draft.png", animations: "disabled" });
}
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mobile.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
await mobile.waitForTimeout(2000);
await mobile.evaluate((snap) => {
  const current = JSON.parse(localStorage.getItem("sinan-assets-v1") ?? "{}");
  localStorage.setItem(
    "sinan-assets-v1",
    JSON.stringify({ ...current, state: { ...current.state, ...snap, view: "agent" } }),
  );
}, snapshot);
await mobile.reload({ waitUntil: "networkidle" });
await mobile.waitForTimeout(2000);
info.mobileHasTidy = (await mobile.locator(".agent-tidy").count()) > 0;
await mobile
  .locator(".agent-tidy")
  .screenshot({ path: "screenshots/tidy-mobile-block.png", animations: "disabled" })
  .catch(() => {});
await mobile.screenshot({ path: "screenshots/tidy-mobile.png", animations: "disabled" });
info.mobileOverflow = await mobile.evaluate(
  () => document.documentElement.scrollWidth - window.innerWidth,
);
info.errors = errors;
console.log(JSON.stringify(info, null, 2));
await browser.close();
