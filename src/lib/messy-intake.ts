import type { Snapshot } from "./types.ts";

/**
 * 「AI 智能整理」：把用户随手粘贴的一堆杂乱数据拆成条目，再认出资产类型，
 * 把已知、缺失与推断分开列清楚。纯函数，不联网。
 *
 * 识别可以交给本机模型（Ollama / LM Studio，数据不出这台电脑）或云端模型；
 * 传输给云端的文本默认先在本地脱敏。无论哪种，结果都要逐条审阅，用户确认后才写入。
 */

export type IntakeAssetKind =
  "server" | "domain" | "service" | "cert" | "mail" | "ai" | "phone" | "secret";

export type IntakeModelMode = "local" | "cloud";

export interface IntakeField {
  field: string;
  label: string;
  value: string;
  /** 由模型补充或修正的字段标出来，审阅时能分清哪部分是模型猜的。 */
  source?: "model";
}

export interface IntakeEntry {
  id: string;
  /** 原文里对应的原始行，审阅时原样展示。 */
  line: string;
  /** 这条记录讲的是谁，例如 example.com；认不出来时为空。 */
  title: string;
  kind: IntakeAssetKind;
  /** 判为这一类的依据，一句话，便于用户纠正。 */
  reason: string;
  /** 原样照抄的字段，不进行推断。 */
  known: IntakeField[];
  /** 原文里没有、需要用户补的必填字段。 */
  missing: string[];
  /** 由已有信息推算出的字段（例如日期），带推断依据。 */
  inferred: IntakeField[];
  /** 需要用户确认的问题。 */
  questions: string[];
  /** 原文里解析不了的片段。 */
  unparsed: string[];
  /** 与已保存资产同名，可能是重复记录。 */
  saved?: { kind: string; id: string; name: string };
  /** 含凭据类内容，默认不出现在发给云端模型的文本里。 */
  sensitive: boolean;
  /** 用户认为这条是噪音：不计入汇总，也不复制或交给模型。 */
  ignored?: boolean;
}

export interface IntakeBundle {
  raw: string;
  entries: IntakeEntry[];
  counts: Record<IntakeAssetKind, number>;
  /** 缺口按字段汇总，例如「未填写到期日 2 项」。 */
  gaps: Array<{ label: string; count: number }>;
}

export interface Redaction {
  text: string;
  /** 占位符对应原值。只放在本机内存，不写入资料、不发给模型。 */
  secrets: Map<string, string>;
  count: number;
}

export const INTAKE_KINDS: IntakeAssetKind[] = [
  "server",
  "domain",
  "service",
  "cert",
  "mail",
  "ai",
  "phone",
  "secret",
];

export const INTAKE_KIND_NAMES: Record<IntakeAssetKind, string> = {
  server: "服务器",
  domain: "域名",
  service: "服务",
  cert: "证书",
  mail: "邮箱",
  ai: "AI 订阅",
  phone: "号码",
  secret: "账号 / 密钥",
};

/** 占位符形如 {{S1}}：只含 ASCII，模型一般能原样抄回。 */
const PLACEHOLDER = /\{\{S(\d+)\}\}/g;

/** 敏感片段。每条只替换第 1 个捕获组，保留「密码：」这样的标记。 */
const SECRET_PATTERNS: Array<{ key: string; re: RegExp }> = [
  {
    key: "key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----/,
  },
  {
    key: "token",
    re: /\b(?:sk|sk-ant|sk-proj|xai|rk|hf|ghp|gho|ghs|glpat|AKIA)[-_A-Za-z0-9]{12,}\b/,
  },
  { key: "token", re: /\bgithub_pat_[A-Za-z0-9_]{10,}\b/ },
  { key: "token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { key: "token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/ },
  { key: "password", re: /(?:密码|口令|password|passwd|pwd)(?:\s*[:：=]\s*|\s+)(\S+)/gi },
  {
    key: "secret",
    re: /(?:token|secret|apikey|accesskey)(?:\s*[:：=]\s*|\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
  },
  { key: "code", re: /(?:验证码|动态码|otp|code)(?:\s*[:：=]\s*|\s+)(\d{6,8})/gi },
  { key: "code", re: /(?:恢复码|备用码|recovery)(?:\s*[:：=]\s*|\s+)([A-Za-z0-9-]{6,})/gi },
  {
    key: "port",
    re: /(?:授权码|客户端授权密码|app[_-]?password)(?:\s*[:：=]\s*|\s+)([A-Za-z0-9]{8,})/gi,
  },
];

const LINE_BREAK = String.fromCharCode(10);

/** 一次脱敏过程共用同一张占位符表，同一片段在整份结果里始终是同一个编号。 */
function createRedactor() {
  const secrets = new Map<string, string>();
  const byValue = new Map<string, string>();
  const substitute = (key: string, value: string): string => {
    const id = key + "\u0000" + value;
    const known = byValue.get(id);
    if (known) return known;
    const at = "{{S" + (secrets.size + 1) + "}}";
    byValue.set(id, at);
    secrets.set(at, value);
    return at;
  };

  const redact = (raw: string): string => {
    // 私钥和证书是跨行的，先在整段文本上换掉。
    const text = String(raw ?? "").replace(
      /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]+?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/g,
      (whole) => substitute("key", whole),
    );

    // 其余凭据按行处理，避免一条正则跨行吃掉上下文。
    return text
      .split(LINE_BREAK)
      .map((source) => {
        let line = source;
        for (const { key, re } of SECRET_PATTERNS) {
          if (key === "key") continue;
          line = line.replace(re, (whole, group) => {
            const value = typeof group === "string" ? group : whole;
            if (!value.trim()) return whole;
            const at = substitute(key, value);
            return typeof group === "string" ? whole.replace(group, at) : at;
          });
        }
        return line;
      })
      .join(LINE_BREAK);
  };

  return { redact, secrets };
}

/** 云端模型只收脱敏文本：凭据换成占位符，同一片段占位符保持一致。 */
export function redactText(raw: string): Redaction {
  const redactor = createRedactor();
  const text = redactor.redact(raw);
  return { text, secrets: redactor.secrets, count: redactor.secrets.size };
}

/**
 * 按条目结构脱敏：只替换条目里的原文和字段值，条目的数量、顺序与 index 完全不变。
 * 交给模型的 prompt 直接取自这份结果，避免「先脱敏、再重新切条」造成错位。
 */
export function redactBundle(bundle: IntakeBundle): {
  bundle: IntakeBundle;
  secrets: Map<string, string>;
  count: number;
} {
  const redactor = createRedactor();
  const entries = bundle.entries.map((entry) => ({
    ...entry,
    line: redactor.redact(entry.line),
    title: redactor.redact(entry.title),
    known: entry.known.map((item) => ({ ...item, value: redactor.redact(item.value) })),
    inferred: entry.inferred.map((item) => ({ ...item, value: redactor.redact(item.value) })),
  }));
  return {
    bundle: { ...bundle, raw: redactor.redact(bundle.raw), entries },
    secrets: redactor.secrets,
    count: redactor.secrets.size,
  };
}

/** 把模型回答里的占位符换回原值；只给用户看，不写进发给模型的历史。 */
export function unredactText(text: string, secrets: Map<string, string>): string {
  return String(text ?? "").replace(PLACEHOLDER, (whole) => secrets.get(whole) ?? whole);
}

/** 支持 2026-11-03、2026/11/3、2026.11.3、2026年11月3日、11-03、11/3。 */
const DATE_TEXT =
  /^(?:(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?|(\d{1,2})\s*[-/.]\s*(\d{1,2}))$/;

/** 年月日是否在日历上真实存在（排除 2 月 30 日这类拼写）。 */
function realDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const at = new Date(year, month - 1, day);
  return at.getMonth() === month - 1 && at.getDate() === day;
}

/**
 * 把一段文字里的日期解析成 YYYY-MM-DD。
 * 没有年份的按今年；直接写月份日期的，已经过去超过 30 天就当明年（续费日一般指下一次）。
 */
export function readDate(text: string, now = new Date()): string | undefined {
  const match = DATE_TEXT.exec(String(text).trim());
  if (!match) return undefined;
  const hasYear = Boolean(match[1]);
  let year = hasYear ? Number(match[1]) : now.getFullYear();
  const month = Number(match[2] ?? match[4]);
  const day = Number(match[3] ?? match[5]);
  if (!hasYear) {
    const thisYear = new Date(year, month - 1, day);
    if (thisYear.getTime() < now.getTime() - 30 * 86_400_000) year += 1;
  }
  if (!realDay(year, month, day)) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/// 本机识别：把粘贴的文本按行分组，认出每条记录是什么

const IPV4 = /\b((?:\d{1,3}\.){3}\d{1,3})\b/;
const DOMAIN_NAME =
  /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|cn|net|org|io|dev|app|xyz|top|me|co|cc|info|site|online|cloud|tech|store|shop|vip|link|fun|pro|ai|so|gg|tv|us|uk|de|jp|hk|tw|sg|ru|fr|nl|ca|au))\b/i;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const URL_TEXT = /\bhttps?:\/\/[^\s"'<>]+/i;
const PHONE = /(?:\+?86[-\s]?)?1[3-9]\d{9}\b/;
const SSH_LINE = /^\s*ssh\s+(?:-\S+\s+)*(?:[\w.-]+@)?([\w.-]+)(?:\s+-p\s*(\d+))?/i;

const MONEY = /(?:([¥￥$])\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(元|块|美元|usd|cny|rmb))/i;
const CYCLE = /(?:每|\/)\s*(月|年|季|天)|(month|year|annual|monthly|yearly)/i;

/** 一行里是否出现了「这是谁」的线索：认出身份的行才会另起一条记录。 */
export function hasIdentity(line: string): boolean {
  return (
    IPV4.test(line) ||
    EMAIL.test(line) ||
    URL_TEXT.test(line) ||
    PHONE.test(line) ||
    DOMAIN_NAME.test(line) ||
    /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/.test(line)
  );
}

/** 从一行里取金额、币种与周期；没有周期时按「未填写周期」返回 amount。 */
export function readMoney(
  line: string,
): { amount: number; currency: "CNY" | "USD"; cycle?: string } | undefined {
  const match = MONEY.exec(line);
  if (!match) return undefined;
  const amount = Number(match[2] ?? match[3]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const currency = match[1] === "$" || /美元|usd/i.test(match[4] ?? "") ? "USD" : "CNY";
  const cycleMatch = CYCLE.exec(line);
  const word = cycleMatch?.[1] ?? cycleMatch?.[2] ?? "";
  const cycle =
    word === "月" || word === "month" || word === "monthly"
      ? "month"
      : word === "年" || word === "year" || word === "yearly" || word === "annual"
        ? "year"
        : undefined;
  return cycle ? { amount, currency, cycle } : { amount, currency };
}

/** 金额按币种显示：人民币用 ¥，美元用 $。 */
function moneyText(amount: number, currency: "CNY" | "USD"): string {
  return (currency === "USD" ? "$" : "¥") + Math.round(amount * 100) / 100;
}

/** 一行是否像是新的一条记录：有身份线索，或带类型关键词同时提到钱/日期。 */
function startsRecord(line: string): boolean {
  if (hasIdentity(line)) return true;
  return KIND_HINT.test(line) && (MONEY.test(line) || DATE_ANY.test(line));
}

/** 把粘贴的文本切成一条条记录：新记录另起一条，其余行并入上一条。 */
export function groupLines(raw: string): string[][] {
  const groups: string[][] = [];
  let current: string[] | undefined;
  for (const source of String(raw ?? "").split(LINE_BREAK)) {
    const line = source.trim();
    if (!line) continue;
    if (!current || startsRecord(line)) {
      current = [line];
      groups.push(current);
    } else {
      current.push(line);
    }
  }
  return groups;
}

const AI_WORDS =
  /(openai|anthropic|claude|chatgpt|gemini|grok|xai|deepseek|kimi|moonshot|cohere|mistral|perplexity|copilot|cursor|通义|千问|豆包|智谱|文心|月之暗面|订阅|会员|subscription|\bplan\b)/i;
const MAIL_WORDS = /(邮箱|邮局|邮件|imap|smtp|pop3|授权码|企业邮|mailbox|e-?mail)/i;
const CERT_WORDS = /(证书|ssl|tls|\bpem\b|acme|let'?s encrypt|certificate)/i;
const SERVER_WORDS =
  /(服务器|主机|vps|云服务器|轻量|阿里云|腾讯云|华为云|ec2|digitalocean|vultr|linode|hetzner|oracle|甲骨文|宝塔|带宽|\bssh\b|\broot\b|ubuntu|centos|debian)/i;
const DOMAIN_WORDS =
  /(域名|注册商|nameserver|whois|备案|dns|cloudflare|godaddy|namecheap|namesilo)/i;
const SERVICE_WORDS = /(服务|站点|网站|worker|vercel|netlify|后台|面板|api 服务|接口)/i;
const PHONE_WORDS = /(手机号|手机号码|号码|电话|运营商|移动|联通|电信|号卡)/i;
const KIND_HINT =
  /(服务器|主机|域名|证书|邮箱|订阅|会员|服务|号码|手机|vps|openai|chatgpt|claude|gemini|grok|deepseek|kimi|阿里云|腾讯云|华为云|cloudflare|vercel|netlify)/i;

/** 认一行记录属于哪类资产，并给出一句话依据。顺序决定撞车时谁赢。 */
export function classifyGroup(group: string[]): { kind: IntakeAssetKind; reason: string } {
  const text = group.join("\n");
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text))
    return { kind: "secret", reason: "含私钥正文" };
  if (/-----BEGIN CERTIFICATE-----/.test(text)) return { kind: "cert", reason: "含证书 PEM" };
  if (EMAIL.test(text) && /(密码|授权码|imap|smtp|邮局|邮箱)/i.test(text))
    return { kind: "mail", reason: "含邮箱地址与登录信息" };
  if (MAIL_WORDS.test(text) && EMAIL.test(text)) return { kind: "mail", reason: "含邮箱线索" };
  if (AI_WORDS.test(text)) return { kind: "ai", reason: "含 AI 服务或订阅关键词" };
  if (CERT_WORDS.test(text)) return { kind: "cert", reason: "含证书关键词" };
  if (PHONE_WORDS.test(text) && PHONE.test(text)) return { kind: "phone", reason: "含手机号码" };
  if (DOMAIN_WORDS.test(text) && DOMAIN_NAME.test(text))
    return { kind: "domain", reason: "含域名注册线索" };
  if (SSH_LINE.test(text) || SERVER_WORDS.test(text))
    return { kind: "server", reason: "含主机或 SSH 线索" };
  if (SERVICE_WORDS.test(text) || URL_TEXT.test(text))
    return { kind: "service", reason: "含服务网址" };
  if (MAIL_WORDS.test(text)) return { kind: "mail", reason: "含邮箱关键词" };
  if (EMAIL.test(text)) return { kind: "mail", reason: "含邮箱地址" };
  if (DOMAIN_NAME.test(text)) return { kind: "domain", reason: "含域名" };
  if (IPV4.test(text)) return { kind: "server", reason: "含 IP 地址" };
  return { kind: "secret", reason: "没有明显类型线索，按账号记录处理" };
}

/** 在已保存资料里找可能重复的记录；只做对照，不自动合并。 */
function findSaved(
  snapshot: Partial<Snapshot>,
  kind: IntakeAssetKind,
  identity: string,
): IntakeEntry["saved"] {
  if (!identity) return undefined;
  const same = (value?: string) =>
    Boolean(value) && value!.toLowerCase() === identity.toLowerCase();
  const pick = (list: Array<{ id: string; name: string }> | undefined) =>
    (list ?? []).find((item) => same(item.name));
  if (kind === "server") {
    const hit = (snapshot.servers ?? []).find(
      (item) => item.host === identity || same(item.name) || same(item.host),
    );
    return hit ? { kind: "server", id: hit.id, name: hit.name } : undefined;
  }
  if (kind === "domain") {
    const hit = pick(snapshot.domains);
    return hit ? { kind: "domain", id: hit.id, name: hit.name } : undefined;
  }
  if (kind === "mail") {
    const hit = (snapshot.mailboxes ?? []).find((item) => same(item.address));
    return hit ? { kind: "mail", id: hit.id, name: hit.address } : undefined;
  }
  if (kind === "ai") {
    const hit = pick(snapshot.aiAssets);
    return hit ? { kind: "ai", id: hit.id, name: hit.name } : undefined;
  }
  if (kind === "cert") {
    const hit = (snapshot.certs ?? []).find((item) => same(item.cn));
    return hit ? { kind: "cert", id: hit.id, name: hit.cn } : undefined;
  }
  if (kind === "service") {
    const hit = pick(snapshot.services);
    return hit ? { kind: "service", id: hit.id, name: hit.name } : undefined;
  }
  if (kind === "phone") {
    const hit = (snapshot.phoneNumbers ?? []).find((item) => item.number === identity);
    return hit ? { kind: "phone", id: hit.id, name: hit.number } : undefined;
  }
  return undefined;
}

/** 这类记录最要紧的几项资料；缺了就会在一键整理里冒出来。 */
const NEEDED: Record<IntakeAssetKind, string[]> = {
  server: ["到期日", "费用"],
  domain: ["到期日", "费用"],
  service: ["到期日", "费用"],
  cert: ["到期日"],
  mail: ["容量"],
  ai: ["月费", "续费日"],
  phone: ["到期日", "费用"],
  secret: ["登录地址"],
};

const DATE_FIND =
  /(\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?|\d{1,2}\s*[-/.]\s*\d{1,2})/g;

/** 文本里第一个能解析的日期。 */
function firstDate(text: string, now: Date): string | undefined {
  for (const match of String(text).matchAll(DATE_FIND)) {
    const iso = readDate(match[1], now);
    if (iso) return iso;
  }
  return undefined;
}

const field = (fieldName: string, label: string, value: string): IntakeField => ({
  field: fieldName,
  label,
  value,
});

/** 从一条记录里抽出的字段；只做照抄和格式化，不做猜测。 */
export function knownFields(kind: IntakeAssetKind, text: string, now: Date): IntakeField[] {
  const out: IntakeField[] = [];
  const dateText = text;
  const expires = firstDate(dateText, now);
  const money = readMoney(text);

  if (kind === "server") {
    const ssh = SSH_LINE.exec(text);
    const ip = IPV4.exec(text);
    const host = ssh?.[1] ?? ip?.[1] ?? DOMAIN_NAME.exec(text)?.[1];
    if (host) out.push(field("host", "主机地址", host));
    const port = ssh?.[2] ?? /(?:端口|port)\s*[:：]?\s*(\d{2,5})/i.exec(text)?.[1];
    if (port) out.push(field("port", "端口", port));
    const user = /(?:用户名|账号|user(?:name)?)\s*[:：]?\s*([\w.-]{1,32})/i.exec(text)?.[1];
    if (user) out.push(field("username", "用户名", user));
  }
  if (kind === "domain") {
    const name = DOMAIN_NAME.exec(text)?.[1];
    if (name) out.push(field("name", "域名", name.toLowerCase()));
    const registrar = /(?:注册商|registrar)\s*[:：]?\s*([^\s,;，。]{1,40})/i.exec(text)?.[1];
    if (registrar) out.push(field("registrar", "注册商", registrar));
  }
  if (kind === "mail") {
    const address = EMAIL.exec(text)?.[0];
    if (address) out.push(field("address", "邮箱", address.toLowerCase()));
  }
  if (kind === "ai") {
    const provider =
      /(openai|anthropic|claude|chatgpt|gemini|grok|xai|deepseek|kimi|moonshot|cohere|mistral|perplexity|copilot|cursor|通义|千问|豆包|智谱|文心)/i.exec(
        text,
      )?.[1];
    if (provider) out.push(field("provider", "服务商", provider));
    const label = /(?:套餐|plan|会员)\s*[:：]?\s*([^\s,;，。]{1,40})/i.exec(text)?.[1];
    if (label) out.push(field("plan", "套餐", label));
  }
  if (kind === "cert") {
    const cn = DOMAIN_NAME.exec(text)?.[1];
    if (cn) out.push(field("cn", "证书域名", cn.toLowerCase()));
    const issuer = /(?:签发者|issuer)\s*[:：]?\s*([^\s,;，。]{1,40})/i.exec(text)?.[1];
    if (issuer) out.push(field("issuer", "签发者", issuer));
  }
  if (kind === "service") {
    const url = URL_TEXT.exec(text)?.[0];
    if (url) out.push(field("url", "网址", url));
  }
  if (kind === "phone") {
    const number = PHONE.exec(text)?.[0];
    if (number) out.push(field("number", "号码", number));
    const carrier = /(移动|联通|电信|广电)/.exec(text)?.[1];
    if (carrier) out.push(field("provider", "运营商", carrier));
  }
  if (expires) out.push(field("expiresAt", "到期日", expires));
  if (money) {
    const period =
      money.cycle === "month" ? "每月" : money.cycle === "year" ? "每年" : "周期未注明";
    out.push(field("billing", "费用", `${moneyText(money.amount, money.currency)} · ${period}`));
  }
  return out;
}

/** 标题取最能代表这条记录的身份字段。 */
function titleOf(kind: IntakeAssetKind, text: string, known: IntakeField[]): string {
  const value = (name: string) => known.find((item) => item.field === name)?.value;
  const identity =
    value("address") ??
    value("cn") ??
    value("name") ??
    value("host") ??
    value("number") ??
    value("url") ??
    EMAIL.exec(text)?.[0];
  if (identity) return identity;
  return text.split(LINE_BREAK)[0].slice(0, 40);
}

const has = (known: IntakeField[], name: string) =>
  known.some((item) => item.field === name && item.value.trim());

/** 一条记录里还缺哪些资料；只列对续费和整理有实际影响的字段。 */
function missingOf(kind: IntakeAssetKind, known: IntakeField[]): string[] {
  const needed = NEEDED[kind];
  const missing: string[] = [];
  if (!has(known, "expiresAt") && needed.includes("到期日")) missing.push("到期日");
  if (!has(known, "billing") && needed.includes("费用")) missing.push("费用");
  if (kind === "ai" && !has(known, "billing")) missing.push("月费");
  if (kind === "domain" && !has(known, "registrar")) missing.push("注册商");
  if (kind === "mail" && !has(known, "address")) missing.push("邮箱地址");
  if (kind === "server" && !has(known, "host")) missing.push("主机地址");
  if (kind === "phone" && !has(known, "number")) missing.push("号码");
  if (kind === "secret" && !has(known, "url")) missing.push("登录地址");
  return [...new Set(missing)];
}

/** 由已有信息推算出来的结论，标明依据，供用户核对。 */
function inferredOf(
  kind: IntakeAssetKind,
  text: string,
  known: IntakeField[],
  now: Date,
): IntakeField[] {
  const out: IntakeField[] = [];
  const expires = known.find((item) => item.field === "expiresAt")?.value;
  if (expires) {
    const days = Math.ceil(
      (new Date(expires + "T00:00:00").getTime() - now.getTime()) / 86_400_000,
    );
    out.push(
      field(
        "expiresIn",
        "距离到期",
        days < 0 ? `已过期 ${-days} 天` : days === 0 ? "今天到期" : `${days} 天`,
      ),
    );
  }
  const money = readMoney(text);
  if (money?.cycle === "month")
    out.push(field("yearly", "年支出", moneyText(money.amount * 12, money.currency)));
  if (money?.cycle === "year")
    out.push(field("monthly", "月均", moneyText(money.amount / 12, money.currency)));
  return out;
}

const DATE_ANY =
  /(?:\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?|\d{1,2}\s*[-/.]\s*\d{1,2})/;

/** 把一条记录变成可审阅的条目；kindOverride 用于用户手动改类型后重新抽字段。 */
export function readEntry(
  group: string[],
  snapshot: Partial<Snapshot>,
  now: Date,
  index: number,
  kindOverride?: IntakeAssetKind,
): IntakeEntry {
  const text = group.join(LINE_BREAK);
  const classified = classifyGroup(group);
  const kind = kindOverride ?? classified.kind;
  const reason =
    kindOverride === undefined
      ? classified.reason
      : `手动改为${INTAKE_KIND_NAMES[kindOverride]}，字段按这一类重新识别`;
  const known = knownFields(kind, text, now);
  const title = titleOf(kind, text, known);
  const missing = missingOf(kind, known);
  const inferred = inferredOf(kind, text, known, now);
  const identity =
    known.find((item) => ["address", "name", "cn", "host", "number"].includes(item.field))?.value ??
    "";
  const saved = findSaved(snapshot, kind, identity);
  const sensitive = SECRET_PATTERNS.some(({ re }) =>
    new RegExp(re.source, re.flags.replace("g", "")).test(text),
  );

  const questions: string[] = [];
  if (saved) questions.push(`资料里已经有「${saved.name}」，这次是更新它，还是另存一条？`);
  if (missing.includes("到期日")) questions.push("没有到期日：是长期有效，还是忘了写？");
  if (missing.includes("费用") || missing.includes("月费"))
    questions.push("费用没写清楚：是每月、每年，还是一次性？");
  if (reason.startsWith("没有明显类型线索")) questions.push("这条像账号记录，要记成哪一类？");

  // 认不出类型时把原文当待确认内容；其余情况只列明显没有用上的行。
  const unparsed =
    reason.startsWith("没有明显类型线索") || kind === "secret"
      ? group.filter((line) => !DATE_ANY.test(line) && !URL_TEXT.test(line))
      : [];

  return {
    id: `intake-${index + 1}-${kind}`,
    line: text,
    title,
    kind,
    reason,
    known,
    missing,
    inferred,
    questions,
    unparsed,
    saved,
    sensitive,
  };
}

/** 按未被忽略的条目重算分类计数与缺口汇总。 */
function summarize(raw: string, entries: IntakeEntry[]): IntakeBundle {
  const counts = Object.fromEntries(INTAKE_KINDS.map((kind) => [kind, 0])) as Record<
    IntakeAssetKind,
    number
  >;
  const gaps = new Map<string, number>();
  for (const entry of entries) {
    if (entry.ignored) continue;
    counts[entry.kind] += 1;
    for (const gap of entry.missing) gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
  }
  return {
    raw,
    entries,
    counts,
    gaps: [...gaps].map(([label, count]) => ({ label, count })),
  };
}

/** 把整份粘贴文本整理成条目、各类计数与缺口汇总。 */
export function parseMessyText(
  raw: string,
  snapshot: Partial<Snapshot> = {},
  now = new Date(),
): IntakeBundle {
  const groups = groupLines(raw);
  const entries = groups.map((group, index) => readEntry(group, snapshot, now, index));
  return summarize(String(raw ?? ""), entries);
}

/**
 * 用户手动改一条记录的类型：按新类型重新抽字段，条目位置与 id 不变。
 * 模型先前补的字段，只要新类型也接受，就继续保留。
 */
export function reclassifyEntry(
  bundle: IntakeBundle,
  index: number,
  kind: IntakeAssetKind,
  snapshot: Partial<Snapshot> = {},
  now = new Date(),
): IntakeBundle {
  const previous = bundle.entries[index];
  if (!previous || previous.kind === kind) return bundle;
  const next = readEntry([previous.line], snapshot, now, index, kind);
  const carried = previous.known.filter(
    (item) =>
      item.source === "model" &&
      CORRECTABLE[kind].includes(item.field) &&
      !next.known.some((known) => known.field === item.field),
  );
  const known = [...next.known, ...carried];
  // 保留下来的模型字段也要算进「已知」，缺口与相应的问题跟着重算。
  const missing = missingOf(kind, known);
  const questions = next.questions.filter(
    (question) =>
      !(question.startsWith("没有到期日") && !missing.includes("到期日")) &&
      !(
        question.startsWith("费用没写清楚") &&
        !missing.includes("费用") &&
        !missing.includes("月费")
      ),
  );
  const entries = bundle.entries.map((entry, at) =>
    at === index
      ? { ...next, id: previous.id, ignored: previous.ignored, known, missing, questions }
      : entry,
  );
  return summarize(bundle.raw, entries);
}

/** 忽略或恢复一条记录：忽略的条目不计数、不复制，也不交给模型。 */
export function setEntryIgnored(
  bundle: IntakeBundle,
  index: number,
  ignored: boolean,
): IntakeBundle {
  if (!bundle.entries[index]) return bundle;
  const entries = bundle.entries.map((entry, at) => (at === index ? { ...entry, ignored } : entry));
  return summarize(bundle.raw, entries);
}

/** 模型只能改已有条目，不能新增或删除：避免凭空造出资产。 */
export interface IntakeCorrection {
  index: number;
  kind?: IntakeAssetKind;
  title?: string;
  fields?: Record<string, unknown>;
}

/** 每条记录允许模型填写的字段。 */
const CORRECTABLE: Record<IntakeAssetKind, string[]> = {
  server: ["host", "port", "username", "expiresAt", "billing"],
  domain: ["name", "registrar", "expiresAt", "billing"],
  service: ["url", "expiresAt", "billing"],
  cert: ["cn", "issuer", "expiresAt"],
  mail: ["address", "domain"],
  ai: ["provider", "plan", "monthlyUsd", "renewsAt"],
  phone: ["number", "provider", "expiresAt", "billing"],
  secret: ["url", "username"],
};

/** 从模型回答里取出 JSON；允许外面包一层说明文字或代码块。 */
export function parseIntakeResponse(text: string): IntakeCorrection[] {
  const source = String(text ?? "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(source.slice(start, end + 1)) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(
      (item): item is IntakeCorrection =>
        Boolean(item) &&
        typeof item === "object" &&
        Number.isInteger((item as IntakeCorrection).index),
    );
  } catch {
    return [];
  }
}

/** 把模型给的字段规范化；非法值直接丢弃，不写进结果。 */
function cleanFields(kind: IntakeAssetKind, fields: Record<string, unknown>): IntakeField[] {
  const allowed = CORRECTABLE[kind];
  const out: IntakeField[] = [];
  for (const [name, raw] of Object.entries(fields ?? {})) {
    if (!allowed.includes(name)) continue;
    if (name === "expiresAt" || name === "renewsAt") {
      const iso = typeof raw === "string" ? readDate(raw) : undefined;
      if (iso) out.push(field(name, name === "renewsAt" ? "续费日" : "到期日", iso));
      continue;
    }
    if (name === "billing") {
      const billing = normalizeBillingValue(raw);
      if (billing)
        out.push(
          field(
            "billing",
            "费用",
            `${moneyText(billing.amount, billing.currency)} · ${
              billing.cycle === "month" ? "每月" : billing.cycle === "year" ? "每年" : "一次性"
            }`,
          ),
        );
      continue;
    }
    if (name === "monthlyUsd") {
      const value = typeof raw === "string" ? Number(raw) : raw;
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e6)
        out.push(field("monthlyUsd", "美元月费", `$${Math.round(value * 100) / 100}`));
      continue;
    }
    if (typeof raw === "string" && raw.trim() && raw.length <= 200)
      out.push(
        field(name, name === "host" ? "主机地址" : name === "url" ? "网址" : name, raw.trim()),
      );
  }
  for (const item of out) item.source = "model";
  return out;
}

/** 只接受金额、币种与周期都合法的费用。 */
function normalizeBillingValue(
  raw: unknown,
): { amount: number; currency: "CNY" | "USD"; cycle: "month" | "year" | "once" } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  const amount = typeof item.amount === "string" ? Number(item.amount) : item.amount;
  const currency = item.currency === "USD" || item.currency === "CNY" ? item.currency : undefined;
  const cycle =
    item.cycle === "month" || item.cycle === "year" || item.cycle === "once"
      ? item.cycle
      : undefined;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || !currency || !cycle)
    return undefined;
  return { amount: Math.round(amount * 100) / 100, currency, cycle };
}

/** 按模型给的修正更新条目；返回新的结果对象，不改原数组。 */
export function applyCorrections(
  bundle: IntakeBundle,
  corrections: IntakeCorrection[],
): IntakeBundle {
  const entries = bundle.entries.map((entry) => ({ ...entry }));
  for (const item of corrections) {
    const entry = entries[item.index];
    if (!entry || entry.ignored) continue;
    const kind = INTAKE_KINDS.includes(item.kind as IntakeAssetKind)
      ? (item.kind as IntakeAssetKind)
      : entry.kind;
    const known = [...entry.known];
    const extra = cleanFields(kind, (item.fields ?? {}) as Record<string, unknown>);
    for (const next of extra) {
      const at = known.findIndex((old) => old.field === next.field);
      if (at >= 0) known[at] = next;
      else known.push(next);
    }
    entries[item.index] = {
      ...entry,
      kind,
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : entry.title,
      known,
      reason: `${entry.reason}；模型补充`,
    };
  }
  return summarize(bundle.raw, entries);
}

/** 交给模型的整理指令：只输出 JSON 修正，不新增条目。 */
export function intakePrompt(bundle: IntakeBundle): string {
  const lines = bundle.entries.flatMap((entry, index) => {
    if (entry.ignored) return [];
    const known = entry.known.map((item) => `${item.field}=${item.value}`).join("；") || "无";
    return [
      `${index}. [${entry.kind}] ${entry.line.replace(/\s+/g, " ").slice(0, 300)}\n   已识别：${known}`,
    ];
  });
  return [
    "下面是从用户粘贴的杂乱资料里切出的记录，已按行拆分。请逐条核对类型和字段。",
    "只输出 JSON，不要解释：",
    '{"entries":[{"index":0,"kind":"server","title":"名称","fields":{"expiresAt":"YYYY-MM-DD","billing":{"amount":99,"currency":"CNY","cycle":"month"}}}]}',
    "规则：index 从 0 开始，必须来自下面的列表；kind 只能是 server/domain/service/cert/mail/ai/phone/secret；",
    "只能补用户原文里已经写明、或能由原文直接算出的字段，不要猜测；原文没写的不要填；",
    "日期统一 YYYY-MM-DD；费用必须同时有 amount、currency（CNY 或 USD）和 cycle（month/year/once）。",
    "",
    ...(lines.length ? lines : ["（没有需要整理的记录。）"]),
  ].join("\n");
}

/** 云端回答里的占位符换回原值；只用于本地展示与落库前核对。 */
export function unredactCorrections(
  corrections: IntakeCorrection[],
  secrets: Map<string, string>,
): IntakeCorrection[] {
  const restore = (value: string) => unredactText(value, secrets);
  return corrections.map((item) => ({
    ...item,
    ...(item.title ? { title: restore(item.title) } : {}),
    fields: Object.fromEntries(
      Object.entries(item.fields ?? {}).map(([key, value]) => [
        key,
        typeof value === "string" ? restore(value) : value,
      ]),
    ),
  }));
}

/** 复制给用户或贴进对话的纯文本整理结果。 */
export function intakeList(bundle: IntakeBundle): string {
  const kept = bundle.entries.filter((entry) => !entry.ignored);
  const hidden = bundle.entries.length - kept.length;
  const lines = [`Helself 粘贴整理 · ${kept.length} 条记录`];
  for (const entry of kept) {
    lines.push("", `[${INTAKE_KIND_NAMES[entry.kind]}] ${entry.title}`);
    if (entry.known.length)
      lines.push(`  已知：${entry.known.map((item) => `${item.label} ${item.value}`).join("；")}`);
    if (entry.inferred.length)
      lines.push(
        `  推算：${entry.inferred.map((item) => `${item.label} ${item.value}`).join("；")}`,
      );
    if (entry.missing.length) lines.push(`  还缺：${entry.missing.join("、")}`);
    if (entry.saved) lines.push(`  资料里已有：${entry.saved.name}`);
    if (entry.questions.length) lines.push(`  待确认：${entry.questions.join(" ")}`);
  }
  if (hidden) lines.push("", `另有 ${hidden} 条已忽略。`);
  return lines.join("\n");
}

/**
 * 「去录入」的预填值：把整理结果映射成各资产表单使用的键。
 *
 * 只带原文里已经写明的字段；密码、私钥等凭据不在这里展开，
 * 需要的话由录入表单自己的智能粘贴再读一遍原文。金额按识别到的币种与周期填写。
 */
export function intakePreset(entry: IntakeEntry): Record<string, string> {
  const value = (name: string) =>
    entry.known.find((item) => item.field === name)?.value.trim() ?? "";
  const money = readMoney(entry.line);
  const preset: Record<string, string> = {};
  if (money) {
    preset.billingAmount = String(money.amount);
    preset.billingCurrency = money.currency;
    preset.billingCycle = money.cycle ?? "once";
  }
  const expiresAt = value("expiresAt");
  if (expiresAt && entry.kind !== "ai") preset.expiresAt = expiresAt;

  switch (entry.kind) {
    case "server": {
      preset.name = value("host") || entry.title;
      if (value("host")) preset.host = value("host");
      if (value("port")) preset.port = value("port");
      if (value("username")) preset.username = value("username");
      break;
    }
    case "domain": {
      if (value("name")) preset.name = value("name");
      if (value("registrar")) preset.registrar = value("registrar");
      break;
    }
    case "service": {
      preset.name = entry.title;
      if (value("url")) preset.url = value("url");
      break;
    }
    case "cert": {
      if (value("cn")) preset.cn = value("cn");
      if (value("issuer")) preset.issuer = value("issuer");
      break;
    }
    case "mail": {
      const address = value("address");
      if (address) {
        preset.address = address;
        preset.domain = address.split("@")[1] ?? "";
      }
      break;
    }
    case "ai": {
      preset.name = entry.title;
      if (value("provider")) preset.provider = value("provider");
      if (value("plan")) preset.plan = value("plan");
      if (expiresAt) preset.renewsAt = expiresAt;
      delete preset.billingAmount;
      delete preset.billingCurrency;
      delete preset.billingCycle;
      // AI 表单按美元月费记录；人民币金额不换算，留空让用户自己确认。
      preset.monthlyUsd =
        money?.currency === "USD" && money.cycle === "month"
          ? String(money.amount)
          : money?.currency === "USD" && money.cycle === "year"
            ? String(Math.round((money.amount / 12) * 100) / 100)
            : "";
      break;
    }
    case "phone": {
      if (value("number")) preset.number = value("number");
      if (value("provider")) preset.provider = value("provider");
      break;
    }
    case "secret": {
      preset.kind = "account";
      if (entry.title) preset.name = entry.title;
      if (value("url")) preset._url = value("url");
      if (value("username")) preset._username = value("username");
      break;
    }
  }
  return preset;
}
