import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "./types.ts";
import { buildTidyReport, tidyList, tidyPlan, tidyReport } from "./work-tidy.ts";

const NOW = new Date("2026-03-01T08:00:00Z");
const iso = (days: number) =>
  new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10);

const EMPTY: Partial<Snapshot> = {
  servers: [],
  domains: [],
  services: [],
  mailboxes: [],
  aiAssets: [],
  certs: [],
  phoneNumbers: [],
};

const ids = (plan: ReturnType<typeof tidyPlan>) => plan.items.map((item) => item.id);

const host = {
  id: "host-1",
  name: "A",
  label: "A",
  host: "203.0.113.10",
  port: 22,
  username: "root",
  os: "Debian 13",
  region: "sh",
  status: "online" as const,
  cpu: 1,
  memory: 40,
  disk: 70,
  uptime: "1",
  lastSeen: "2026-03-01",
  notes: "",
  tags: ["prod"],
};
const rented = { amount: 600, currency: "CNY" as const, cycle: "year" as const };
const baseDomain = {
  id: "domain-1",
  name: "a.test",
  registrar: "Cloudflare",
  dns: "",
  nameservers: [],
  autoRenew: false,
  status: "online" as const,
  tags: ["web"],
  notes: "",
  billing: rented,
};
const baseAi = {
  id: "ai-1",
  name: "Claude",
  provider: "Anthropic",
  plan: "Pro",
  keyHint: "",
  monthlyUsd: 20,
  usagePct: 40,
  status: "online" as const,
  tags: ["ai"],
  notes: "",
};

const mail = (id: string, usedMb: number, quotaMb: number) => ({
  id,
  address: `${id}@x.test`,
  domain: "x.test",
  kind: "mailbox" as const,
  usedMb,
  quotaMb,
  status: "online" as const,
  tags: ["mail"],
  notes: "",
});

test("过期天数用正数放在 days 上，100 天后到期不进清单", () => {
  const plan = tidyPlan(
    {
      ...EMPTY,
      domains: [
        { ...baseDomain, id: "gone", name: "gone.test", expiresAt: iso(-4) },
        { ...baseDomain, id: "soon", name: "soon.test", expiresAt: iso(9) },
        { ...baseDomain, id: "late", name: "late.test", expiresAt: iso(100) },
      ],
    },
    NOW,
  );
  assert.deepEqual(ids(plan), ["domain:gone:expired", "domain:soon:expiring"]);
  assert.equal(plan.items[0].days, -4);
  assert.equal(plan.items[0].detail, "4 天前到期");
  assert.equal(plan.counts.expiring, 1);
  assert.equal(plan.groups.length, 2);
});

test("离线主机算状态异常，但演示资产不进清单", () => {
  const plan = tidyPlan(
    {
      ...EMPTY,
      servers: [
        {
          ...host,
          id: "off",
          name: "off",
          status: "offline",
          expiresAt: iso(300),
          billing: rented,
        },
        { ...host, id: "demo", name: "demo", status: "offline", demo: true },
      ],
    },
    NOW,
  );
  assert.deepEqual(ids(plan), ["server:off:offline"]);
  // 演示资产完全不进清单：既不报异常，也不报缺字段。
  assert.equal(plan.groups[0].title, "状态异常");
});

test("邮箱容量过半才提示；AI 订阅按续费日提示核对，缺费用与缺到期日分开算", () => {
  const plan = tidyPlan(
    {
      ...EMPTY,
      mailboxes: [mail("full", 840, 1000), mail("roomy", 100, 1000)],
      aiAssets: [
        { ...baseAi, id: "ai-soon", renewsAt: iso(2) },
        { ...baseAi, id: "ai-far", renewsAt: iso(200) },
      ],
      phoneNumbers: [
        {
          id: "num-1",
          number: "num-1",
          label: "",
          provider: "x",
          expiresAt: "",
          notes: "",
          subscriptionIds: [],
          createdAt: "",
          updatedAt: "",
        },
      ],
    },
    NOW,
  );
  const ids2 = ids(plan);
  assert.ok(ids2.includes("mail:full:expiring-credit"));
  assert.ok(!ids2.includes("mail:roomy:expiring-credit"));
  assert.ok(ids2.includes("ai:ai-soon:expiring-credit"));
  assert.ok(!ids2.includes("ai:ai-far:expiring-credit"));
  assert.ok(ids2.includes("phone:num-1:missing-date"));
});

test("同类型按剩余天数排队；整份清单的问题计入总条数，单项问题带资产名", () => {
  const plan = tidyPlan(
    {
      ...EMPTY,
      domains: [
        { ...baseDomain, id: "d20", name: "d20.test", expiresAt: iso(20) },
        { ...baseDomain, id: "d3", name: "d3.test", expiresAt: iso(3) },
      ],
      certs: [
        {
          id: "c1",
          cn: "cert.test",
          issuer: "LE",
          expiresAt: iso(11),
          sans: [],
          status: "warning",
          notes: "",
          tags: [],
        },
      ],
    },
    NOW,
  );
  assert.deepEqual(
    plan.groups.find((g) => g.kind === "expiring")?.items.map((i) => i.title),
    ["d3.test", "cert.test", "d20.test"],
  );
  assert.ok(plan.prompt.includes("一键整理"));
  assert.deepEqual(
    plan.groups.map((g) => g.kind),
    ["expiring", "offline", "missing-billing", "untagged"],
  );
  assert.match(plan.items[0].question, /d3\.test/);
});

test("整理页签的 report：按类计数，明细带资产引用，问题按优先级排序", () => {
  const report = tidyReport(
    {
      ...EMPTY,
      domains: [
        { ...baseDomain, id: "gone", name: "gone.test", expiresAt: iso(-4) },
        { ...baseDomain, id: "soon", name: "soon.test", expiresAt: iso(9) },
      ],
      servers: [
        {
          ...host,
          id: "off",
          name: "off",
          status: "offline",
          expiresAt: iso(300),
          billing: rented,
        },
      ],
      mailboxes: [mail("full", 840, 1000)],
    },
    NOW,
  );
  assert.equal(report.total, 5);
  assert.deepEqual(
    report.groups.map((group) => [group.issue, group.count]),
    [
      ["expired", 1],
      ["expiring", 1],
      ["offline", 1],
      ["expiring-credit", 1],
      ["missing-billing", 1],
    ],
  );
  const first = report.items[0];
  assert.deepEqual(first, {
    assetKind: "domain",
    assetId: "gone",
    name: "gone.test",
    issue: "expired",
    daysLeft: -4,
    detail: "4 天前到期",
  });
  const soon = buildTidyReport(
    tidyPlan({ ...EMPTY, domains: [{ ...baseDomain, expiresAt: iso(200) }] }, NOW),
    NOW,
  );
  assert.match(soon.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(soon.groups, []);
});

test("复制清单：按组列出，每条带类型、名称与情况", () => {
  const plan = tidyPlan(
    { ...EMPTY, domains: [{ ...baseDomain, id: "gone", name: "gone.test", expiresAt: iso(-4) }] },
    NOW,
  );
  const text = tidyList(plan);
  assert.match(text, /1 项待整理/);
  assert.match(text, /已经过期（1）/);
  assert.match(text, /- 域名「gone\.test」：4 天前到期/);
  assert.equal(tidyList(tidyPlan(EMPTY, NOW)).split("\n").length, 1);
});
