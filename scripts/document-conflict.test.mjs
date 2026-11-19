import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DocumentsStore, documentRevision } from "../electron/services/documents.mjs";
import { hashDocumentFile } from "../electron/services/sync-hash.mjs";
import { createWebServer } from "../selfhost/server.mjs";

const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const resolved = new URL(specifier, context.parentURL);
      if (!/\.[cm]?[jt]sx?$/.test(resolved.pathname) && existsSync(fileURLToPath(resolved) + ".ts"))
        return nextResolve(resolved.href + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const { useDocuments } = await import("../src/lib/documents.ts");
hook.deregister();

const draft = (id = "doc-conflict", title = "原始文档") => ({
  id,
  title,
  content: { type: "doc", content: [{ type: "paragraph" }] },
  bindings: [],
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

async function storeFixture(t, save) {
  const directory = await mkdtemp(join(tmpdir(), "helself-document-conflict-"));
  const store = new DocumentsStore(directory);
  useDocuments.setState({
    list: [],
    drafts: {},
    savedSummaries: {},
    status: {},
    errors: {},
    selected: null,
    loaded: false,
  });
  globalThis.window = {
    sinan: {
      documents: {
        list: () => store.list(),
        get: (id) => store.get(id),
        save: async (doc, options) => {
          const saved = save
            ? await save(store, doc, options)
            : await store.save(doc, { ...options, requireRevision: true });
          useDocuments.getState().acceptChange({ document: saved });
          return saved;
        },
        remove: (id) => store.remove(id),
      },
    },
  };
  t.after(async () => {
    delete globalThis.window;
    await rm(directory, { recursive: true, force: true });
  });
  const saved = await store.save(draft());
  await useDocuments.getState().load();
  await useDocuments.getState().open(saved.id);
  return { store, saved, directory };
}

await test("真实 HTTP 保存拒绝旧版本、缺失版本和已删除文档，保留远端修改", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "helself-document-http-"));
  const staticDir = join(root, "static");
  const web = await createWebServer({
    root,
    staticDir,
    schedulePush: false,
    sampleHost: false,
    log: { log() {}, error() {} },
  });
  await new Promise((resolve) => web.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    web.server.closeAllConnections();
    await new Promise((resolve) => web.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${web.server.address().port}`;
  let cookie = "";
  const call = async (path, method = "GET", body) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method !== "GET" ? { "content-type": "application/json", "x-helself": "1" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const session = response.headers.get("set-cookie");
    if (session) cookie = session.split(";")[0];
    return response;
  };
  const setup = await call("/api/web/setup", "POST", {
    username: "document-test",
    password: "isolated-test-password-2026",
    token: web.setupToken,
  });
  assert.equal(setup.status, 200);
  const path = "/api/web/documents/doc-http";
  const createdResponse = await call(path, "PUT", draft("doc-http"));
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  const editorA = await (await call(path)).json();
  const editorB = await (await call(path)).json();
  const savedResponse = await call(path, "PUT", { ...editorA, title: "编辑者 A" });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.notEqual(saved.revision, created.revision);
  assert.equal((await call(path, "PUT", { ...editorB, title: "编辑者 B" })).status, 409);
  const { revision: _revision, ...withoutRevision } = editorB;
  assert.equal((await call(path, "PUT", withoutRevision)).status, 409);
  assert.equal((await call(path, "PUT", { ...saved, expectedRevision: [] })).status, 400);
  assert.equal((await (await call(path)).json()).title, "编辑者 A");
  const disk = JSON.parse(await readFile(join(root, "workspace/documents/doc-http.json"), "utf8"));
  assert.equal(Object.hasOwn(disk, "revision"), false);
  assert.equal(hashDocumentFile(saved), hashDocumentFile(disk));
  assert.equal((await call(path, "DELETE", {})).status, 200);
  assert.equal((await call(path, "PUT", saved)).status, 409);
});

await test("保存中继续编辑会推进修订基线，第二次保存不会误报冲突", async (t) => {
  const pending = deferred();
  const started = deferred();
  const versions = [];
  const { store, saved } = await storeFixture(t, async (backend, doc, options) => {
    versions.push(options.expectedRevision);
    if (versions.length === 1) {
      started.resolve();
      await pending.promise;
    }
    return backend.save(doc, { ...options, requireRevision: true });
  });
  useDocuments.getState().change({ ...useDocuments.getState().drafts[saved.id], title: "第一步" });
  const saving = useDocuments.getState().flush(saved.id);
  await started.promise;
  useDocuments.getState().change({ ...useDocuments.getState().drafts[saved.id], title: "第二步" });
  pending.resolve();
  await saving;
  assert.equal(versions.length, 2);
  assert.equal(versions[0], saved.revision);
  assert.notEqual(versions[1], versions[0]);
  const current = await store.get(saved.id);
  assert.equal(current.title, "第二步");
  assert.equal(useDocuments.getState().drafts[saved.id].revision, current.revision);
  assert.equal(useDocuments.getState().status[saved.id], "saved");
  assert.equal(useDocuments.getState().errors[saved.id], "");
});

await test("冲突保留草稿，另存失败不清空，成功后可继续打开最新原文", async (t) => {
  let copyFails = true;
  const { store, saved } = await storeFixture(t, (backend, doc, options) => {
    if (doc.id !== "doc-conflict" && copyFails) throw new Error("模拟副本写入失败");
    return backend.save(doc, { ...options, requireRevision: true });
  });
  const remote = await store.save({ ...saved, title: "其他设备的修改" });
  useDocuments
    .getState()
    .change({ ...useDocuments.getState().drafts[saved.id], title: "本地草稿" });
  await assert.rejects(useDocuments.getState().flush(saved.id), /其他位置修改/);
  const beforeCopy = useDocuments.getState().drafts[saved.id];
  assert.equal(useDocuments.getState().status[saved.id], "error");
  await assert.rejects(useDocuments.getState().saveCopy(saved.id), /模拟副本写入失败/);
  assert.equal(useDocuments.getState().drafts[saved.id], beforeCopy);
  assert.equal(useDocuments.getState().selected, saved.id);
  copyFails = false;
  await useDocuments.getState().saveCopy(saved.id);
  const copyId = useDocuments.getState().selected;
  assert.notEqual(copyId, saved.id);
  assert.equal((await store.get(copyId)).title, "本地草稿 · 副本");
  assert.equal((await store.get(saved.id)).title, remote.title);
  assert.equal(useDocuments.getState().drafts[saved.id], undefined);
  assert.equal(useDocuments.getState().status[saved.id], undefined);
  assert.equal(useDocuments.getState().errors[saved.id], undefined);
  assert.equal(useDocuments.getState().status[copyId], "saved");
  assert.equal(useDocuments.getState().drafts[copyId].revision, (await store.get(copyId)).revision);
  assert.equal(useDocuments.getState().list.filter((doc) => doc.id === copyId).length, 1);
  await useDocuments.getState().open(saved.id);
  assert.equal(useDocuments.getState().drafts[saved.id].title, remote.title);
  assert.equal(useDocuments.getState().drafts[saved.id].revision, remote.revision);
  assert.equal(useDocuments.getState().list.find((doc) => doc.id === saved.id).title, remote.title);
});

await test("另存期间的新输入保留在原草稿，不被副本响应清空", async (t) => {
  const pending = deferred();
  const started = deferred();
  const { store, saved } = await storeFixture(t, async (backend, doc, options) => {
    if (doc.id !== "doc-conflict") {
      started.resolve();
      await pending.promise;
    }
    return backend.save(doc, { ...options, requireRevision: true });
  });
  await store.save({ ...saved, title: "远端内容" });
  useDocuments
    .getState()
    .change({ ...useDocuments.getState().drafts[saved.id], title: "准备另存" });
  await assert.rejects(useDocuments.getState().flush(saved.id));
  const copying = useDocuments.getState().saveCopy(saved.id);
  await started.promise;
  useDocuments
    .getState()
    .change({ ...useDocuments.getState().drafts[saved.id], title: "另存期间输入" });
  pending.resolve();
  await copying;
  assert.equal(useDocuments.getState().drafts[saved.id].title, "另存期间输入");
  assert.equal((await store.get(useDocuments.getState().selected)).title, "准备另存 · 副本");
  await assert.rejects(useDocuments.getState().flush(saved.id));
});

await test("旧文档读取后提供版本，修订号与 Node SHA256 算法保持一致", async (t) => {
  const { store, saved, directory } = await storeFixture(t);
  const disk = JSON.parse(await readFile(join(directory, saved.id + ".json"), "utf8"));
  assert.equal(Object.hasOwn(disk, "revision"), false);
  const { createHash } = await import("node:crypto");
  const expected = createHash("sha256")
    .update(
      JSON.stringify({
        title: disk.title,
        content: disk.content,
        markdown: disk.markdown,
        bindings: disk.bindings,
        updatedAt: disk.updatedAt,
      }),
    )
    .digest("hex");
  assert.equal(saved.revision, expected);
  assert.equal((await store.get(saved.id)).revision, documentRevision(disk));
  await writeFile(join(directory, saved.id + ".json"), JSON.stringify(disk));
  useDocuments
    .getState()
    .change({ ...useDocuments.getState().drafts[saved.id], title: "编辑旧格式" });
  await useDocuments.getState().flush(saved.id);
  assert.equal((await store.get(saved.id)).title, "编辑旧格式");
});
