import type { StateStorage } from "zustand/middleware";
import { toast } from "sonner";
import { webApi, WebConflictError } from "./web";
import { createWebSaveQueue } from "./web-save-queue";
import { t } from "./i18n";

let revision: string | null = null;
let reload: (() => Promise<void>) | null = null;
let recovered: string | null | undefined;
const SAVE_ERROR_ID = "web-store-save";

function showSaveError(error: unknown) {
  toast.error(t("保存失败：{0}", error instanceof Error ? error.message : String(error)), {
    id: SAVE_ERROR_ID,
    duration: Infinity,
    action: { label: t("重试"), onClick: () => saves.retry() },
  });
}

const saves = createWebSaveQueue({
  async write(value) {
    const response = await webApi<{ revision: string }>("store", {
      method: "PUT",
      body: { revision, data: JSON.parse(value) },
    });
    revision = response.revision;
    toast.dismiss(SAVE_ERROR_ID);
  },
  isConflict: (error) => error instanceof WebConflictError,
  async recover() {
    // 只读一次最新快照，再交给 rehydrate；读取失败时继续阻止旧快照写回。
    const response = await webApi<{ revision: string | null; data: unknown }>("store");
    revision = response.revision;
    recovered = response.data ? JSON.stringify(response.data) : null;
    saves.acknowledge(recovered);
    try {
      await reload?.();
    } finally {
      recovered = undefined;
    }
    toast.dismiss(SAVE_ERROR_ID);
    toast.warning(t("资料已在另一台设备更新，已载入最新内容；刚才的修改请再做一次"));
  },
  onError: showSaveError,
});

export async function flushWebStore(): Promise<boolean> {
  try {
    await saves.flush();
    return true;
  } catch (error) {
    showSaveError(error);
    return false;
  }
}

export const webStorage: StateStorage = {
  async getItem() {
    if (recovered !== undefined) return recovered;
    if (saves.hasPending() && !saves.isRecovering()) return saves.latest();
    const response = await webApi<{ revision: string | null; data: unknown }>("store");
    // 读取期间可能又有编辑，远端快照不能覆盖尚未保存的本机内容。
    if (saves.hasPending() && !saves.isRecovering()) return saves.latest();
    revision = response.revision;
    const value = response.data ? JSON.stringify(response.data) : null;
    saves.acknowledge(value);
    return value;
  },
  setItem: (_name, value) => saves.enqueue(value),
  // 清空资料通过资料管理完成，移除持久化键不能绕过版本校验。
  removeItem: () => {},
};

/** 回到页面、恢复联网时先保存草稿，再检查其他设备的更新。 */
export function startWebSync(rehydrate: () => Promise<void>) {
  reload = rehydrate;
  let checking = false;
  const check = async () => {
    if (checking || document.visibilityState !== "visible") return;
    if (saves.hasPending()) {
      saves.retry();
      return;
    }
    checking = true;
    try {
      const response = await webApi<{ revision: string | null }>("store");
      if (response.revision !== revision && !saves.hasPending()) await rehydrate();
    } catch (error) {
      console.warn("[web-store] 检查远端资料失败，将在恢复联网后重试", error);
    } finally {
      checking = false;
    }
  };
  const onVisible = () => {
    if (document.visibilityState === "hidden") saves.retry();
    else void check();
  };
  const onHide = () => saves.retry();
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!saves.hasPending()) return;
    saves.retry();
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("focus", onVisible);
  window.addEventListener("online", onVisible);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pagehide", onHide);
  window.addEventListener("beforeunload", onBeforeUnload);
  const interval = setInterval(onVisible, 60_000);
  return () => {
    window.removeEventListener("focus", onVisible);
    window.removeEventListener("online", onVisible);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("beforeunload", onBeforeUnload);
    clearInterval(interval);
    if (reload === rehydrate) reload = null;
  };
}
