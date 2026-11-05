import assert from "node:assert/strict";
import { test } from "node:test";
import { intakeFormPreset } from "./intake-preset.ts";
import { applyCorrections, editField, parseMessyText } from "./messy-intake.ts";

test("录入沿用手动修正的域名，不让原文识别覆盖", () => {
  const bundle = parseMessyText("example.com 注册商 Cloudflare 到期 2026-12-01");
  const edited = editField(bundle, 0, "name", "corrected.com");
  assert.ok(edited);
  assert.equal(intakeFormPreset(edited.entries[0]).name, "corrected.com");
});

test("SSH 原文的密码保留，手动修改的主机和端口优先", () => {
  let bundle = parseMessyText("ssh root@203.0.113.7 -p 22 密码 qa-only-password");
  bundle = applyCorrections(bundle, [
    { index: 0, kind: "server", fields: { host: "203.0.113.8", port: "2202" } },
  ]);
  const preset = intakeFormPreset(bundle.entries[0]);
  assert.equal(preset.host, "203.0.113.8");
  assert.equal(preset.port, "2202");
  assert.equal(preset.username, "root");
});

test("模型修正后的费用、币种和周期一起带入表单", () => {
  const bundle = applyCorrections(parseMessyText("example.com ¥55/年"), [
    {
      index: 0,
      fields: { billing: { amount: 12, currency: "USD", cycle: "month" } },
    },
  ]);
  const preset = intakeFormPreset(bundle.entries[0]);
  assert.equal(preset.billingAmount, "12");
  assert.equal(preset.billingCurrency, "USD");
  assert.equal(preset.billingCycle, "month");
});

test("AI 订阅修正后的美元月费和续费日不会丢失", () => {
  const bundle = applyCorrections(parseMessyText("ChatGPT Plus $20 每月 到期 2026-12-01"), [
    {
      index: 0,
      kind: "ai",
      fields: { monthlyUsd: 30, renewsAt: "2027-02-01" },
    },
  ]);
  const preset = intakeFormPreset(bundle.entries[0]);
  assert.equal(preset.monthlyUsd, "30");
  assert.equal(preset.renewsAt, "2027-02-01");
  assert.equal(preset.billingAmount, undefined);
});

test("人民币 AI 费用不会误当成美元，号码不经过其他资产的识别器", () => {
  const ai = parseMessyText("ChatGPT Plus ¥120 每月").entries[0];
  assert.equal(intakeFormPreset(ai).monthlyUsd, "");
  const phone = parseMessyText("13800138000 移动 号码 月租 39 元").entries[0];
  assert.equal(intakeFormPreset(phone).number, "13800138000");
});

test("API Key 录入保留凭据子类型", () => {
  const key = `sk-proj-${"q".repeat(32)}`;
  const entry = parseMessyText(key).entries[0];
  assert.equal(entry.kind, "secret");
  assert.equal(intakeFormPreset(entry).kind, "api");
});
