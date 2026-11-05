import {
  FileText,
  Phone,
  ChartNoAxesCombined,
  Bot,
  CalendarClock,
  Cloud,
  Globe,
  House,
  KeyRound,
  Mail,
  Server,
  MessagesSquare,
  Shield,
  SquareTerminal,
  Tags,
  Radio,
  type LucideIcon,
} from "lucide-react";
import type { AssetKind, ViewId } from "./types";
import type { attentionOf } from "./status";

export interface NavGroup {
  title: string;
  items: {
    id: ViewId;
    label: string;
    icon: LucideIcon;
    badgeKey?: keyof ReturnType<typeof attentionOf>;
    kind?: AssetKind;
    countKey?:
      "servers" | "domains" | "mailboxes" | "aiAssets" | "secrets" | "certs" | "services" | "nodes";
  }[];
}

// 按使用场景分组：日常入口在前，同类资产相邻，低频工具收进可折叠分组。
export const NAV_GROUPS: NavGroup[] = [
  {
    title: "工作台",
    items: [
      { id: "overview", label: "资产总览", icon: House, badgeKey: "total" },
      { id: "renewals", label: "费用与续费", icon: CalendarClock },
      { id: "docs", label: "文档资产", icon: FileText },
      { id: "agent", label: "AI 助手", icon: MessagesSquare },
    ],
  },
  {
    title: "基础设施",
    items: [
      {
        id: "servers",
        label: "服务器",
        icon: Server,
        badgeKey: "servers",
        kind: "server",
        countKey: "servers",
      },
      { id: "nodes", label: "自建节点", icon: Radio, countKey: "nodes" },
      {
        id: "domains",
        label: "域名",
        icon: Globe,
        badgeKey: "domains",
        kind: "domain",
        countKey: "domains",
      },
      {
        id: "certs",
        label: "安全证书",
        icon: Shield,
        badgeKey: "certs",
        kind: "cert",
        countKey: "certs",
      },
      {
        id: "services",
        label: "服务资产",
        icon: Cloud,
        badgeKey: "services",
        kind: "service",
        countKey: "services",
      },
    ],
  },
  {
    title: "账号与订阅",
    items: [
      { id: "ai", label: "AI 订阅", icon: Bot, badgeKey: "ai", kind: "ai", countKey: "aiAssets" },
      { id: "usage", label: "用量记录", icon: ChartNoAxesCombined },
      {
        id: "mail",
        label: "邮箱",
        icon: Mail,
        badgeKey: "mail",
        kind: "mail",
        countKey: "mailboxes",
      },
      { id: "phones", label: "号码管理", icon: Phone, badgeKey: "phones" },
    ],
  },
  {
    title: "安全与整理",
    items: [
      {
        id: "vault",
        label: "密钥库",
        icon: KeyRound,
        badgeKey: "vault",
        kind: "secret",
        countKey: "secrets",
      },
      { id: "tags", label: "标签", icon: Tags },
    ],
  },
  {
    title: "工具",
    items: [{ id: "terminal", label: "终端", icon: SquareTerminal }],
  },
];

// 扁平导出给快捷键或其他模块使用
export const NAV = NAV_GROUPS.flatMap((g) => g.items);
