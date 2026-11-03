import type { Snapshot } from "./types.ts";

/**
 * 「一键整理」：把工作区里需要补的信息按优先级列成清单。
 * 只读快照、不改数据；清单交给 AI 后仍然先生成建议，由用户逐条确认再应用。
 */

export type TidyKind =
  | "expired"
  | "expiring"
  | "offline"
  | "expiring-credit"
  | "missing-date"
  | "missing-billing"
  | "untagged";

export interface TidyItem {
  id: string;
  kind: TidyKind;
  title: string;
  detail: string;
  /** 剩余天数，负数表示已经过期。 */
  days?: number;
  /** 只整理这一项时可以直接问 AI 的问题。 */
  question: string;
}

export interface TidyGroup {
  kind: TidyKind;
  title: string;
  items: TidyItem[];
}

export interface TidyPlan {
  items: TidyItem[];
  counts: Record<TidyKind, number>;
  groups: TidyGroup[];
  total: number;
  /** 交给 AI 时的问题；没有可整理的项目时为空字符串。 */
  prompt: string;
}

/** 清点分为几档的判断口径：30 天内到期、容量或额度用到八成才提示。 */
export const SOON_DAYS = 30;
export const CREDIT_SOON = 0.8;
export const CREDIT_SOON_DAYS = 45;

export const TIDY_ORDER: TidyKind[] = [
  "expired",
  "expiring",
  "offline",
  "expiring-credit",
  "missing-date",
  "missing-billing",
  "untagged",
];

export const TIDY_TITLES_ZH = {
  expired: "已经过期",
  expiring: "30 天内到期",
  offline: "状态异常",
  "expiring-credit": "额度将满",
  "missing-date": "缺少到期日",
  "missing-billing": "缺少费用",
  untagged: "还没有标签",
} satisfies Record<TidyKind, string>;

export const KIND_NAME = {
  server: "服务器",
  domain: "域名",
  service: "服务资产",
  ai: "AI 订阅",
  cert: "证书",
  mail: "邮箱",
  phone: "号码",
} as const;

/** 资产类型名称；AI 订阅的「用量」是百分比，不按容量算。 */
type AssetKind = keyof typeof KIND_NAME;

/** 本来就该有到期日的类型：邮箱按容量、AI 按续费日。 */
const DATED = new Set<AssetKind>(["server", "domain", "service", "cert", "phone"]);

interface Entry {
  id: string;
  kind: AssetKind;
  name: string;
  status?: string;
  tags: string[];
  expiresAt?: string;
  billing?: unknown;
  monthlyUsd?: number;
  monthlyUsdKnown?: boolean;
  renewsAt?: string;
  usedMb?: number;
  quotaMb?: number;
  demo?: boolean;
}

function entries(snapshot: Partial<Snapshot>): Entry[] {
  const tags = (item: { tags?: string[] }) =>
    Array.isArray(item.tags) ? item.tags.filter((tag) => tag.trim()) : [];
  const servers = (snapshot.servers ?? []).map((s) => ({
    id: s.id,
    kind: "server" as const,
    name: s.name,
    status: s.status,
    tags: tags(s),
    expiresAt: s.expiresAt,
    billing: s.billing,
    demo: s.demo,
  }));
  const domains = (snapshot.domains ?? []).map((d) => ({
    id: d.id,
    kind: "domain" as const,
    name: d.name,
    status: d.status,
    tags: tags(d),
    expiresAt: d.expiresAt,
    billing: d.billing,
    demo: d.demo,
  }));
  const services = (snapshot.services ?? []).map((s) => ({
    id: s.id,
    kind: "service" as const,
    name: s.name,
    status: s.status,
    tags: tags(s),
    expiresAt: s.expiresAt,
    billing: s.billing,
    demo: s.demo,
  }));
  const ai = (snapshot.aiAssets ?? []).map((a) => ({
    id: a.id,
    kind: "ai" as const,
    name: a.name,
    status: a.status,
    tags: tags(a),
    expiresAt: a.subscriptionExpiresAt ?? undefined,
    renewsAt: a.renewsAt,
    monthlyUsd: a.monthlyUsd,
    monthlyUsdKnown: a.monthlyUsdKnown,
    demo: a.demo,
  }));
  const certs = (snapshot.certs ?? []).map((c) => ({
    id: c.id,
    kind: "cert" as const,
    name: c.cn,
    status: c.status,
    tags: tags(c),
    expiresAt: c.expiresAt,
    demo: c.demo,
  }));
  const mail = (snapshot.mailboxes ?? []).map((m) => ({
    id: m.id,
    kind: "mail" as const,
    name: m.address,
    status: m.status,
    tags: tags(m),
    usedMb: m.usedMb,
    quotaMb: m.quotaMb,
    demo: m.demo,
  }));
  const phone = (snapshot.phoneNumbers ?? []).map((p) => ({
    id: p.id,
    kind: "phone" as const,
    name: p.number,
    tags: [],
    expiresAt: p.expiresAt,
    billing: p.billing,
  }));
  return [...servers, ...domains, ...services, ...ai, ...certs, ...mail, ...phone] as Entry[];
}

function daysLeft(iso: string | undefined, now: Date): number | undefined {
  if (!iso) return undefined;
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return undefined;
  return Math.ceil((at - now.getTime()) / 86_400_000);
}

function dueOf(entry: Entry): string | undefined {
  return entry.kind === "ai" ? (entry.renewsAt ?? entry.expiresAt) : entry.expiresAt;
}

function priced(entry: Entry): boolean {
  if (entry.kind === "ai")
    return entry.monthlyUsdKnown !== false && typeof entry.monthlyUsd === "number";
  return entry.billing != null;
}

function listed(entry: Entry): boolean {
  return entry.demo !== true;
}

export function tidyPlan(snapshot: Partial<Snapshot>, now = new Date()): TidyPlan {
  const items: TidyItem[] = [];
  for (const entry of entries(snapshot)) {
    if (!listed(entry)) continue;
    const left = daysLeft(dueOf(entry), now);
    const push = (kind: TidyKind, detail: string, ask: string, days?: number) =>
      items.push({
        id: `${entry.kind}:${entry.id}:${kind}`,
        kind,
        title: entry.name,
        detail,
        ...(days === undefined ? {} : { days }),
        question: `请为${KIND_NAME[entry.kind]}「${entry.name}」生成修改建议：${ask}`,
      });
    if (left !== undefined) {
      if (left < 0) {
        push("expired", `${-left} 天前到期`, "先确认是否还能续费，再更新到期日。", left);
      } else if (left <= SOON_DAYS) {
        push("expiring", `${left} 天后到期`, "给出续费优先级和要准备的事项。", left);
      }
    }
    if (entry.kind === "server" && entry.status === "offline") {
      push("offline", "采集不到状态", "列出可能原因和排查顺序，写进备注。");
    }
    if (entry.kind === "cert" && entry.status !== "online") {
      push("offline", "证书不受信任或已失效", "说明影响范围，并给出替换证书的步骤。");
    }
    if (entry.kind === "mail" && capacityHigh(entry)) {
      push(
        "expiring-credit",
        `已用 ${entry.usedMb ?? 0} / ${entry.quotaMb ?? 0} MB`,
        "给出清理或扩容建议。",
      );
    }
    if (entry.kind === "ai" && aiChargesSoon(entry, left)) {
      push(
        "expiring-credit",
        `${left} 天后扣费`,
        "核对这个订阅是否还需要，给出取消或降级建议。",
        left,
      );
    }
    if (left === undefined && DATED.has(entry.kind)) {
      push("missing-date", "没有记录", "补上到期日和续费方式。");
    }
    if (!priced(entry)) {
      push(
        "missing-billing",
        entry.kind === "ai" && typeof entry.monthlyUsd !== "number" ? "没有记录" : "未填写",
        "补上金额、币种和周期。",
      );
    }
    if (entry.tags.length === 0) {
      push("untagged", "标签为空", "建议 1-3 个标签，按项目或用途命名，并说明理由。");
    }
  }
  items.sort(
    (a, b) =>
      TIDY_ORDER.indexOf(a.kind) - TIDY_ORDER.indexOf(b.kind) ||
      (a.days ?? Number.MAX_SAFE_INTEGER) - (b.days ?? Number.MAX_SAFE_INTEGER) ||
      a.title.localeCompare(b.title),
  );
  const counts = Object.fromEntries(TIDY_ORDER.map((kind) => [kind, 0])) as Record<
    TidyKind,
    number
  >;
  for (const item of items) counts[item.kind] += 1;
  return {
    items,
    counts,
    groups: TIDY_ORDER.filter((kind) => counts[kind] > 0).map((kind) => ({
      kind,
      title: TIDY_TITLES_ZH[kind],
      items: items.filter((item) => item.kind === kind),
    })),
    total: items.length,
    prompt: items.length ? TIDY_PROMPT : "",
  };
}

function capacityHigh(entry: Entry): boolean {
  const quota = typeof entry.quotaMb === "number" ? entry.quotaMb : 0;
  const used = typeof entry.usedMb === "number" ? entry.usedMb : 0;
  return quota > 0 && used / quota >= CREDIT_SOON;
}

function aiChargesSoon(entry: Entry, left: number | undefined): boolean {
  const monthly = typeof entry.monthlyUsd === "number" ? entry.monthlyUsd : 0;
  return left !== undefined && left >= 0 && left <= CREDIT_SOON_DAYS && monthly > 0;
}

/** 快速清点整份清单的问题。单项问题用 item.question，它带着具体资产名。 */
export const TIDY_PROMPT =
  "一键整理我的资产：按过期、即将到期、离线、额度将满、缺少到期日、缺少费用、还没有标签的顺序逐项检查。能根据已有资料确定的内容直接生成修改建议，不能确定的地方列成问题问我。每类先给一句话总结。";
