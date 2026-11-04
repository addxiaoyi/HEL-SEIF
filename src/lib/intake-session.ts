import { create } from "zustand";
import type { IntakeBundle } from "./messy-intake";

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
  setText: (text: string) => void;
  setResult: (result: IntakeRun | null) => void;
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
  setText: (text) => set({ text }),
  setResult: (result) => set({ result }),
  updateBundle: (update) =>
    set((state) => {
      if (!state.result) return state;
      const bundle = update(state.result.bundle);
      if (bundle === state.result.bundle) return state;
      return { result: { ...state.result, bundle } };
    }),
}));
