interface SaveQueueOptions {
  write: (value: string) => Promise<void>;
  isConflict: (error: unknown) => boolean;
  recover: () => Promise<void>;
  onError: (error: unknown) => void;
  delay?: number;
}

/** 合并短时间内的编辑，串行保存；失败的最新草稿只保留在内存里，等待重试。 */
export function createWebSaveQueue({
  write,
  isConflict,
  recover,
  onError,
  delay = 400,
}: SaveQueueOptions) {
  let saved: string | null = null;
  let pending: string | null = null;
  let active: string | null = null;
  let writing: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let needsReload = false;

  function cancelTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  async function drain() {
    if (needsReload) {
      await recover();
      needsReload = false;
    }
    while (pending !== null) {
      const value = pending;
      pending = null;
      active = value;
      try {
        await write(value);
        saved = value;
      } catch (error) {
        if (isConflict(error)) {
          // 排队快照都基于旧版本，不能拿新版本号重放它们。
          pending = null;
          needsReload = true;
          await recover();
          needsReload = false;
          return;
        }
        pending ??= value;
        throw error;
      } finally {
        active = null;
      }
    }
  }

  function flush(): Promise<void> {
    cancelTimer();
    if (writing) return writing;
    if (pending === null && !needsReload) return Promise.resolve();
    writing = Promise.resolve()
      .then(drain)
      .finally(() => {
        writing = null;
      });
    return writing;
  }

  function retry() {
    void flush().catch(onError);
  }

  return {
    enqueue(value: string) {
      if (needsReload) return;
      cancelTimer();
      // 改完又撤回原值时取消尚未发送的保存；请求已发出则排队写回原值。
      pending = value === saved && !writing ? null : value;
      if (pending !== null) timer = setTimeout(retry, delay);
    },
    acknowledge(value: string | null) {
      saved = value;
    },
    hasPending: () => pending !== null || writing !== null || needsReload,
    latest: () => pending ?? active ?? saved,
    isRecovering: () => needsReload,
    flush,
    retry,
  };
}
