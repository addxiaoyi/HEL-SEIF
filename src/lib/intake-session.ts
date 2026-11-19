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

/** 撤销只留最近这些步，够改错回退，又不会把整份资料留太久。 */
const HISTORY_LIMIT = 20;

interface IntakeSessionState {
  text: string;
  result: IntakeRun | null;
  /** 查看筛选：只影响显示，不影响复制、交给模型或改字段时的条目下标。 */
  filterKind: IntakeAssetKind | "all";
  onlyProblems: boolean;
  /** 手动改动前的 bundle 快照，用来一步撤销；重新整理或清空结果时清掉。 */
  history: IntakeBundle[];
  /** 每个历史快照对应的操作编号；自动刷新不改变编号，提示可以安全撤销原操作。 */
  historyActionIds: number[];
  /** 最近一次会写入历史的操作编号，供短暂的操作提示做并发保护。 */
  lastActionId: number | null;
  /** 手动修改会作废请求，避免迟到的模型回答覆盖草稿。 */
  pendingRun: number | null;
  runError: string;
  setText: (text: string) => void;
  setResult: (result: IntakeRun | null) => void;
  setFilterKind: (kind: IntakeAssetKind | "all") => void;
  setOnlyProblems: (onlyProblems: boolean) => void;
  /**
   * 改类型、忽略、合并、改字段都只换 bundle，其余字段原样保留。
   * 自动刷新（资料库里多了一条）传 false，免得把用户的上一步改动挤出历史。
   */
  updateBundle: (update: (bundle: IntakeBundle) => IntakeBundle, record?: boolean) => void;
  undo: (actionId?: number) => void;
  startRun: () => number | null;
  finishRun: (id: number, result: IntakeRun) => boolean;
  endRun: (id: number, error?: string) => boolean;
}

let nextActionId = 0;
let nextRunId = 0;

function resultState(result: IntakeRun | null) {
  return {
    result,
    ...(result ? { filterKind: "all" as const, onlyProblems: false } : {}),
    history: [],
    historyActionIds: [],
    lastActionId: null,
    pendingRun: null,
    runError: result?.error ?? "",
  };
}

/**
 * 粘贴整理的草稿只放内存：原文里可能有密码和私钥，不写进 localStorage 或磁盘。
 *
 * 关掉面板、去录入一条再回来、切到别的视图，粘贴的内容和整理结果都还在；
 * 刷新页面或退出应用才清空。
 */
export const useIntakeSession = create<IntakeSessionState>()((set, get) => ({
  text: "",
  result: null,
  filterKind: "all",
  onlyProblems: false,
  history: [],
  historyActionIds: [],
  lastActionId: null,
  pendingRun: null,
  runError: "",
  setText: (text) =>
    set((state) => (text === state.text ? state : { text, pendingRun: null, runError: "" })),
  setResult: (result) =>
    // 重新整理时回到全部类型，免得还停在上一次的筛选上看起来像丢了记录。
    set(resultState(result)),
  setFilterKind: (filterKind) => set({ filterKind }),
  setOnlyProblems: (onlyProblems) => set({ onlyProblems }),
  updateBundle: (update, record = true) =>
    set((state) => {
      if (!state.result) return state;
      const bundle = update(state.result.bundle);
      const history = record ? state.history : state.history.map(update);
      const historyChanged = history.some((item, index) => item !== state.history[index]);
      if (bundle === state.result.bundle && !historyChanged) return state;
      if (!record) return { result: { ...state.result, bundle }, history };
      const actionId = ++nextActionId;
      return {
        result: { ...state.result, bundle },
        history: [...state.history, state.result.bundle].slice(-HISTORY_LIMIT),
        historyActionIds: [...state.historyActionIds, actionId].slice(-HISTORY_LIMIT),
        lastActionId: actionId,
        pendingRun: null,
        runError: "",
      };
    }),
  undo: (actionId) =>
    set((state) => {
      if (!state.result || state.history.length === 0) return state;
      const lastActionId = state.historyActionIds.at(-1) ?? null;
      if (actionId !== undefined && actionId !== lastActionId) return state;
      return {
        result: { ...state.result, bundle: state.history[state.history.length - 1] },
        history: state.history.slice(0, -1),
        historyActionIds: state.historyActionIds.slice(0, -1),
        lastActionId: state.historyActionIds.at(-2) ?? null,
        pendingRun: null,
        runError: "",
      };
    }),
  startRun: () => {
    if (get().pendingRun !== null) return null;
    const id = ++nextRunId;
    set({ pendingRun: id, runError: "" });
    return id;
  },
  finishRun: (id, result) => {
    if (get().pendingRun !== id) return false;
    set(resultState(result));
    return true;
  },
  endRun: (id, error = "") => {
    if (get().pendingRun !== id) return false;
    set({ pendingRun: null, runError: error });
    return true;
  },
}));
