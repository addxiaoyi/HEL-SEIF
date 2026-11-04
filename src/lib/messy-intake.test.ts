import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCorrections,
  groupLines,
  intakeList,
  intakePreset,
  intakePrompt,
  parseIntakeResponse,
  parseMessyText,
  readDate,
  readMoney,
  reclassifyEntry,
  redactBundle,
  redactText,
  setEntryIgnored,
  unredactCorrections,
  unredactText,
} from "./messy-intake.ts";

const NOW = new Date("2026-03-01T08:00:00Z");

test("日期解析支持常见写法，没有年份的按今年算", () => {
  assert.equal(readDate("2026-05-01", NOW), "2026-05-01");
  assert.equal(readDate("2026/5/3", NOW), "2026-05-03");
  assert.equal(readDate("2026年5月3日", NOW), "2026-05-03");
  assert.equal(readDate("05-20", NOW), "2026-05-20");
  assert.equal(readDate("2026-02-30", NOW), undefined);
  assert.equal(readDate("不是日期", NOW), undefined);
});

test("认出发票式的一行一条，其余行并入上一条", () => {
  const groups = groupLines(
    "47.100.1.2\nroot 密码 abc\n到期 2026-05-01\nexample.com 到期 2026-08-12",
  );
  assert.equal(groups.length, 2);
  assert.equal(groups[0].length, 3);
  assert.equal(groups[1].length, 1);
});

test("整理一份杂乱粘贴：分类、字段、缺口都对得上", () => {
  const raw = [
    "阿里云 服务器 47.100.1.2 root 密码 Abc123! 到期2026-05-01 ¥99/月",
    "example.com 注册商 阿里云 到期 2026-08-12 ¥55/年",
    "hi@example.com 密码 mailpass 授权码 abcdefgh",
    "ChatGPT Plus 订阅 每月 $20 续费 2026-03-20",
    "13800138000 移动 卡 到期 2026-09-01",
  ].join("\n");
  const bundle = parseMessyText(raw, {}, NOW);
  assert.equal(bundle.entries.length, 5);
  assert.deepEqual(
    bundle.entries.map((entry) => entry.kind),
    ["server", "domain", "mail", "ai", "phone"],
  );
  const server = bundle.entries[0];
  assert.ok(server.known.some((item) => item.field === "host" && item.value === "47.100.1.2"));
  assert.ok(server.known.some((item) => item.field === "expiresAt" && item.value === "2026-05-01"));
  assert.ok(server.sensitive);
  const domain = bundle.entries[1];
  assert.ok(domain.known.some((item) => item.field === "name" && item.value === "example.com"));
  assert.ok(domain.inferred.some((item) => item.field === "monthly"));
  assert.equal(domain.missing.includes("到期日"), false);
  assert.ok(bundle.gaps.some((gap) => gap.label === "费用"));
});

test("与已保存资料同名时提示可能重复，但不自动合并", () => {
  const snapshot = {
    servers: [],
    domains: [{ id: "d1", name: "example.com" }],
    mailboxes: [],
    aiAssets: [],
    certs: [],
    services: [],
    phoneNumbers: [],
  } as never;
  const bundle = parseMessyText("example.com 到期 2026-08-12", snapshot, NOW);
  assert.equal(bundle.entries[0].saved?.id, "d1");
  assert.ok(bundle.entries[0].questions.some((q) => q.includes("已经有")));
});

test("云端脱敏：凭据换占位符，域名和邮箱保留，能还原", () => {
  const raw = [
    "example.com 到期 2026-08-12",
    "hi@example.com 密码 mailpass123",
    "OpenAI key: sk-proj-abcdefghijklmnopqrstuvwx",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAA",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  const result = redactText(raw);
  assert.ok(result.count >= 3);
  assert.ok(!result.text.includes("mailpass123"));
  assert.ok(!result.text.includes("sk-proj-abcdefghijklmnopqrstuvwx"));
  assert.ok(!result.text.includes("b3BlbnNzaC1rZXktdjEAAAAA"));
  assert.ok(result.text.includes("example.com"));
  assert.ok(result.text.includes("hi@example.com"));
  assert.ok(result.text.includes("2026-08-12"));
  const back = unredactText(result.text, result.secrets);
  assert.ok(back.includes("mailpass123"));
  assert.ok(back.includes("b3BlbnNzaC1rZXktdjEAAAAA"));
});

test("同一凭据出现两次只占一个占位符", () => {
  const result = redactText("密码 samepass99\n密码 samepass99");
  assert.equal(result.count, 1);
});

test("模型修正只能改已有条目，非法字段被丢掉", () => {
  const bundle = parseMessyText("47.100.1.2 root 密码 abc", {}, NOW);
  const next = applyCorrections(bundle, [
    {
      index: 0,
      kind: "server",
      title: "阿里云主机",
      fields: {
        expiresAt: "2026年5月1日",
        billing: { amount: 99, currency: "CNY", cycle: "month" },
        host: "evil.example.com",
      },
    },
    { index: 99, title: "不存在的条目" },
  ]);
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].title, "阿里云主机");
  assert.ok(next.entries[0].known.some((item) => item.field === "expiresAt"));
  assert.ok(next.entries[0].known.some((item) => item.field === "billing"));
  assert.ok(next.entries[0].known.some((item) => item.field === "host"));
});

test("模型回答里带说明文字也能取出 JSON，坏 JSON 返回空", () => {
  const parsed = parseIntakeResponse('好的，结果如下：\n```json\n{"entries":[{"index":0}]}\n```');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].index, 0);
  assert.deepEqual(parseIntakeResponse("完全没有 JSON"), []);
  assert.deepEqual(parseIntakeResponse("{broken"), []);
});

test("整理指令包含条目与 JSON 输出要求", () => {
  const bundle = parseMessyText("example.com 到期 2026-08-12", {}, NOW);
  const prompt = intakePrompt(bundle);
  assert.ok(prompt.includes("example.com"));
  assert.ok(prompt.includes('"entries"'));
  assert.ok(prompt.includes("YYYY-MM-DD"));
});

test("费用识别币种：美元不再显示成人民币", () => {
  assert.deepEqual(readMoney("ChatGPT Plus 每月 $20"), {
    amount: 20,
    currency: "USD",
    cycle: "month",
  });
  assert.deepEqual(readMoney("¥99/月"), { amount: 99, currency: "CNY", cycle: "month" });
  const bundle = parseMessyText("ChatGPT Plus 订阅 每月 $20 续费 2026-03-20", {}, NOW);
  assert.ok(bundle.entries[0].known.some((item) => item.value === "$20 · 每月"));
  assert.ok(bundle.entries[0].inferred.some((item) => item.value === "$240"));
});

test("按条目脱敏不改结构，私钥换占位符后 index 仍然对得上", () => {
  const raw = [
    "example.com 到期 2026-08-12",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAA",
    "-----END OPENSSH PRIVATE KEY-----",
    "47.100.1.2 root 密码 Abc123!",
  ].join("\n");
  const bundle = parseMessyText(raw, {}, NOW);
  assert.equal(bundle.entries.length, 3);
  const redacted = redactBundle(bundle);
  assert.equal(redacted.bundle.entries.length, bundle.entries.length);
  assert.deepEqual(
    redacted.bundle.entries.map((entry) => entry.kind),
    bundle.entries.map((entry) => entry.kind),
  );
  assert.ok(redacted.count >= 2);
  assert.ok(redacted.bundle.entries[1].line.includes("{{S1}}"));
  assert.ok(!redacted.bundle.entries[1].line.includes("b3BlbnNzaC1rZXktdjEAAAAA"));
  assert.ok(!redacted.bundle.entries[2].line.includes("Abc123!"));
  const prompt = intakePrompt(redacted.bundle);
  assert.equal((prompt.match(/^\d+\. /gm) ?? []).length, 3);
  const restored = unredactCorrections(
    [{ index: 2, fields: { host: "{{S2}}" } }],
    redacted.secrets,
  );
  assert.equal(restored[0].fields?.host, "Abc123!");
});

test("去录入预填：币种、周期、域名与 AI 月费各就各位", () => {
  const [server] = parseMessyText(
    "阿里云 服务器 47.100.1.2 root 密码 Abc123! 到期2026-05-01 ¥99/月",
    {},
    NOW,
  ).entries;
  assert.deepEqual(intakePreset(server), {
    billingAmount: "99",
    billingCurrency: "CNY",
    billingCycle: "month",
    expiresAt: "2026-05-01",
    name: "47.100.1.2",
    host: "47.100.1.2",
  });

  const [domain] = parseMessyText(
    "example.com 注册商 阿里云 到期 2026-08-12 ¥55/年",
    {},
    NOW,
  ).entries;
  assert.equal(intakePreset(domain).registrar, "阿里云");
  assert.equal(intakePreset(domain).billingCycle, "year");

  const [ai] = parseMessyText("ChatGPT Plus 订阅 每月 $20 续费 2026-03-20", {}, NOW).entries;
  assert.equal(intakePreset(ai).monthlyUsd, "20");
  assert.equal(intakePreset(ai).billingAmount, undefined);
  assert.equal(intakePreset(ai).renewsAt, "2026-03-20");

  const [phone] = parseMessyText("13800138000 移动 卡 到期 2026-09-01", {}, NOW).entries;
  assert.equal(intakePreset(phone).number, "13800138000");
  assert.equal(intakePreset(phone).provider, "移动");
});

test("手动改类型：按新类型重抽字段，id 与顺序不变，计数重算", () => {
  const bundle = parseMessyText(
    [
      "服务器 47.100.1.2 绑 example.com 到期 2026-05-01 ¥99/月",
      "13800138000 移动 卡 到期 2026-09-01",
    ].join("\n"),
    {},
    NOW,
  );
  const before = bundle.entries[0];
  assert.equal(before.kind, "server");
  assert.equal(before.title, "47.100.1.2");
  assert.equal(bundle.counts.server, 1);
  assert.equal(bundle.counts.domain, 0);

  const next = reclassifyEntry(bundle, 0, "domain", {}, NOW);
  const entry = next.entries[0];
  assert.equal(entry.kind, "domain");
  assert.equal(entry.id, before.id);
  assert.equal(entry.title, "example.com");
  assert.equal(entry.reason, "手动改为域名，字段按这一类重新识别");
  assert.ok(entry.known.some((item) => item.field === "name" && item.value === "example.com"));
  assert.equal(next.counts.server, 0);
  assert.equal(next.counts.domain, 1);
  assert.equal(next.counts.phone, 1);
  assert.deepEqual(
    next.entries.map((item) => item.id),
    bundle.entries.map((item) => item.id),
  );
  assert.deepEqual(
    next.entries.map((item) => item.kind),
    ["domain", "phone"],
  );
});

test("改类型时保留新类型也接受的模型字段，不接受就丢掉", () => {
  const base = parseMessyText("47.100.1.2 root 密码 abc", {}, NOW);
  const corrected = applyCorrections(base, [{ index: 0, fields: { expiresAt: "2026年5月1日" } }]);
  assert.equal(
    corrected.entries[0].known.find((item) => item.field === "expiresAt")?.source,
    "model",
  );

  const asDomain = reclassifyEntry(corrected, 0, "domain", {}, NOW);
  const kept = asDomain.entries[0].known.find((item) => item.field === "expiresAt");
  assert.equal(kept?.value, "2026-05-01");
  assert.equal(kept?.source, "model");
  assert.equal(asDomain.entries[0].id, corrected.entries[0].id);

  const asSecret = reclassifyEntry(asDomain, 0, "secret", {}, NOW);
  assert.equal(asSecret.entries[0].kind, "secret");
  assert.equal(
    asSecret.entries[0].known.some((item) => item.field === "expiresAt"),
    false,
  );
});

test("模型补充的字段都标出来源", () => {
  const bundle = parseMessyText("47.100.1.2 root 密码 abc", {}, NOW);
  const next = applyCorrections(bundle, [
    {
      index: 0,
      fields: {
        expiresAt: "2026-05-01",
        billing: { amount: 20, currency: "USD", cycle: "month" },
      },
    },
  ]);
  const known = next.entries[0].known;
  const added = known.filter((item) => item.field !== "host");
  assert.deepEqual(
    added.map((item) => item.field),
    ["expiresAt", "billing"],
  );
  for (const item of added) assert.equal(item.source, "model");
  assert.equal(known.find((item) => item.field === "host")?.source, undefined);
});

test("忽略一条记录：不计数、不进缺口，条目本身还在", () => {
  const bundle = parseMessyText("47.100.1.2 root 密码 abc", {}, NOW);
  assert.ok(bundle.gaps.length > 0);

  const next = setEntryIgnored(bundle, 0, true);
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].ignored, true);
  assert.equal(next.entries[0].id, bundle.entries[0].id);
  assert.equal(next.entries[0].title, bundle.entries[0].title);
  for (const count of Object.values(next.counts)) assert.equal(count, 0);
  assert.deepEqual(next.gaps, []);
});

test("复制结果不列出被忽略的记录，恢复后回到列表", () => {
  const bundle = parseMessyText(
    ["47.100.1.2 root 密码 abc", "example.com 注册商 阿里云 到期 2026-08-12"].join("\n"),
    {},
    NOW,
  );
  const hidden = setEntryIgnored(bundle, 0, true);
  const list = intakeList(hidden);
  assert.equal(list.includes("47.100.1.2"), false);
  assert.ok(list.startsWith("Helself 粘贴整理 · 1 条记录"));
  assert.ok(list.includes("example.com"));
  assert.ok(list.includes("另有 1 条已忽略。"));

  const restored = intakeList(setEntryIgnored(hidden, 0, false));
  assert.equal(restored.includes("另有"), false);
  assert.ok(restored.startsWith("Helself 粘贴整理 · 2 条记录"));
  assert.ok(restored.includes("47.100.1.2"));
});

test("整理指令跳过被忽略的记录，index 仍用原始位置", () => {
  const bundle = parseMessyText(
    ["47.100.1.2 root 密码 abc", "example.com 注册商 阿里云 到期 2026-08-12"].join("\n"),
    {},
    NOW,
  );
  const hidden = setEntryIgnored(bundle, 0, true);
  const prompt = intakePrompt(hidden);
  assert.equal(prompt.includes("47.100.1.2"), false);
  assert.match(prompt, /^1\. \[domain\] example\.com/m);

  const all = setEntryIgnored(hidden, 1, true);
  assert.ok(intakePrompt(all).includes("（没有需要整理的记录。）"));
});

test("模型修正的美元费用按币种显示", () => {
  const bundle = parseMessyText("47.100.1.2 root 密码 abc", {}, NOW);
  const next = applyCorrections(bundle, [
    {
      index: 0,
      fields: { billing: { amount: 20, currency: "USD", cycle: "month" } },
    },
  ]);
  const billing = next.entries[0].known.find((item) => item.field === "billing");
  assert.equal(billing?.value, "$20 · 每月");
  assert.equal(billing?.source, "model");
});
