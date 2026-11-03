import type { TidyKind } from "@/lib/work-tidy.ts";

/** 清单里每一类的名称与提问方向；各项都带中文原文，方便本地化。 */
export const TIDY_LABELS: Record<TidyKind, { detail: string; ask: string }> = {
  expired: { detail: "已经过期", ask: "先确认是否还能续费，再更新到期日。" },
  expiring: { detail: "30 天内到期", ask: "给出续费优先级和要准备的事项。" },
  offline: { detail: "状态离线", ask: "列出可能原因和排查顺序，写进备注。" },
  "expiring-credit": { detail: "额度将满", ask: "核对是否还需要，给出清理、扩容或取消建议。" },
  "missing-date": { detail: "缺少到期日", ask: "补上到期日和续费方式。" },
  "missing-billing": { detail: "缺少费用", ask: "补上金额、币种和周期。" },
  untagged: { detail: "还没有标签", ask: "建议 1-3 个标签，按项目或用途命名，并说明理由。" },
};
