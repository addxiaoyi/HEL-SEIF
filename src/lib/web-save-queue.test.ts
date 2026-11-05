import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebSaveQueue } from "./web-save-queue.ts";

class Conflict extends Error {}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function queue(write: (value: string) => Promise<void>, recover = async () => {}) {
  return createWebSaveQueue({
    write,
    recover,
    isConflict: (error) => error instanceof Conflict,
    onError: (error) => {
      throw error;
    },
  });
}

test("快速连续编辑只写最后一份快照", async () => {
  const writes: string[] = [];
  const saves = queue(async (value) => {
    writes.push(value);
  });
  saves.enqueue("first");
  saves.enqueue("last");
  await saves.flush();
  assert.deepEqual(writes, ["last"]);
  assert.equal(saves.hasPending(), false);
});

test("尚未发送时改回已保存的值，取消旧的待保存内容", async () => {
  const writes: string[] = [];
  const saves = queue(async (value) => {
    writes.push(value);
  });
  saves.acknowledge("original");
  saves.enqueue("edited");
  saves.enqueue("original");
  await saves.flush();
  assert.deepEqual(writes, []);
  assert.equal(saves.hasPending(), false);
});

test("保存中撤销会排队写回原值，所有保存严格串行", async () => {
  const gate = deferred();
  const writes: string[] = [];
  const saves = queue(async (value) => {
    writes.push(value);
    if (writes.length === 1) await gate.promise;
  });
  saves.acknowledge("original");
  saves.enqueue("edited");
  const running = saves.flush();
  await Promise.resolve();
  saves.enqueue("original");
  assert.deepEqual(writes, ["edited"]);
  assert.equal(saves.flush(), running);
  gate.resolve();
  await running;
  assert.deepEqual(writes, ["edited", "original"]);
  assert.equal(saves.hasPending(), false);
});

test("网络失败保留草稿，重试成功后才清除待保存状态", async () => {
  let online = false;
  const writes: string[] = [];
  const saves = queue(async (value) => {
    if (!online) throw new Error("offline");
    writes.push(value);
  });
  saves.enqueue("draft");
  await assert.rejects(saves.flush(), /offline/);
  assert.equal(saves.hasPending(), true);
  assert.equal(saves.latest(), "draft");
  online = true;
  await saves.flush();
  assert.deepEqual(writes, ["draft"]);
  assert.equal(saves.hasPending(), false);
});

test("保存失败期间的新编辑不会被失败请求的旧内容替换", async () => {
  const gate = deferred();
  const writes: string[] = [];
  const saves = queue(async (value) => {
    writes.push(value);
    if (writes.length === 1) await gate.promise;
  });
  saves.enqueue("old");
  const running = saves.flush();
  await Promise.resolve();
  saves.enqueue("new");
  gate.reject(new Error("offline"));
  await assert.rejects(running, /offline/);
  assert.equal(saves.latest(), "new");
  await saves.flush();
  assert.deepEqual(writes, ["old", "new"]);
});

test("冲突后丢弃旧版本排队写入，载入其他设备的版本", async () => {
  const gate = deferred();
  const writes: string[] = [];
  let reloads = 0;
  const saves = queue(
    async (value) => {
      writes.push(value);
      await gate.promise;
    },
    async () => {
      reloads++;
    },
  );
  saves.enqueue("old");
  const running = saves.flush();
  await Promise.resolve();
  saves.enqueue("stale-new");
  gate.reject(new Conflict());
  await running;
  await saves.flush();
  assert.deepEqual(writes, ["old"]);
  assert.equal(reloads, 1);
  assert.equal(saves.hasPending(), false);
});

test("冲突恢复也失败时，下次只重试读取，绝不重放旧版本", async () => {
  const writes: string[] = [];
  let reloads = 0;
  const saves = queue(
    async (value) => {
      writes.push(value);
      throw new Conflict();
    },
    async () => {
      reloads++;
      if (reloads === 1) throw new Error("reload offline");
    },
  );
  saves.enqueue("stale");
  await assert.rejects(saves.flush(), /reload offline/);
  assert.equal(saves.isRecovering(), true);
  saves.enqueue("another stale edit");
  await saves.flush();
  assert.deepEqual(writes, ["stale"]);
  assert.equal(reloads, 2);
  assert.equal(saves.hasPending(), false);
});
