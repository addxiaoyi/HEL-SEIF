import { create } from "zustand";
import type { IntakeAssetKind, IntakeBundle } from "./messy-intake";

/** 一次整理的结果：条目本身加上这次用的是什么模型、脱敏了几处。 */
export interface IntakeRun {
  bundle: IntakeBundle;
  mode: string;
  model: string;
  error: string;
  redacted: number;
}

interface IntakeSessionState {
  text: string;
  result: IntakeRun | null;
  /** 查看筛选：只影响显示，不影响复制、交给模型或改字段时的条目下标。 */
  filterKind: IntakeAssetKind | "all";
  onlyProblems: boolean;
  setText: (text: string) => void;
  setResult: (result: IntakeRun | null) => void;
  setFilterKind: (kind: IntakeAssetKind | "all") => void;
  setOnlyProblems: (onlyProblems: boolean) => void;
  /** 改类型、忽略、刷新已保存状态都只换 bundle，其余字段原样保留。 */
  updateBundle: (update: (bundle: IntakeBundle) => IntakeBundle) => void;
}

/**
 * 粘贴整理的草稿只放内存：原文里可能有密码和私钥，不写进 localStorage 或磁盘。
 *
 * 关掉面板、去录入一条再回来、切到别的视图，粘贴的内容和整理结果都还在；
 * 刷新页面或退出应用才清空。
 */
export const useIntakeSession = create<IntakeSessionState>()((set) => ({
  text: "",
  result: null,
  filterKind: "all",
  onlyProblems: false,
  setText: (text) => set({ text }),
  setResult: (result) =>
    // 重新整理时回到全部类型，免得还停在上一次的筛选上看起来像丢了记录。
    set(result ? { result, filterKind: "all", onlyProblems: false } : { result }),
  setFilterKind: (filterKind) => set({ filterKind }),
  setOnlyProblems: (onlyProblems) => set({ onlyProblems }),
  updateBundle: (update) =>
    set((state) => {
      if (!state.result) return state;
      const bundle = update(state.result.bundle);
      if (bundle === state.result.bundle) return state;
      return { result: { ...state.result, bundle } };
    }),
}));
