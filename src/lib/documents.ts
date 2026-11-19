import { isWeb, webApi } from "./web";
import { randomId } from "./random-id";
import { migrateServerDocument } from "./document-migration.mjs";
import { uploadImage } from "./image-bed";
import { inspectRaster } from "../../electron/services/image-data.mjs";
import { create } from "zustand";
import type { JSONContent } from "@tiptap/react";
import type { AssetRef } from "./operations";
import { desktop } from "./desktop";
import { markdownContent } from "./document-markdown.mjs";
import {
  DocumentConflictError,
  documentRevision,
} from "../../electron/services/document-revision.mjs";

export interface DocumentAsset {
  id: string;
  title: string;
  content: JSONContent;
  markdown?: string;
  bindings: AssetRef[];
  createdAt: string;
  updatedAt: string;
  revision?: string;
}
export interface DocumentSummary extends Omit<DocumentAsset, "content" | "markdown"> {
  excerpt: string;
  imageCount: number;
}
export interface DocumentChange {
  document?: DocumentAsset;
  removedId?: string;
}
export interface DocumentsBridge {
  onChanged?(handler: (change: DocumentChange) => void): () => void;
  list(): Promise<DocumentSummary[]>;
  get(id: string): Promise<DocumentAsset>;
  save(
    doc: DocumentAsset & { createOnly?: boolean },
    options?: { expectedRevision?: string },
  ): Promise<DocumentAsset>;
  remove(id: string): Promise<void>;
}
/** 自托管网页版：文档存在服务器的 documents/ 目录（与桌面版相同）。 */
const webDocuments: DocumentsBridge = {
  list: () => webApi<DocumentSummary[]>("documents"),
  get: (id) => webApi<DocumentAsset>(`documents/${encodeURIComponent(id)}`),
  save: (doc, options) =>
    webApi<DocumentAsset>(`documents/${encodeURIComponent(doc.id)}`, {
      method: "PUT",
      body: { ...doc, expectedRevision: options?.expectedRevision ?? doc.revision },
    }),
  remove: async (id) => {
    await webApi(`documents/${encodeURIComponent(id)}`, { method: "DELETE", body: {} });
  },
};
const local: DocumentsBridge = {
  async list() {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("nanpad-doc:doc-"));
    return keys
      .map((k) => summary(JSON.parse(localStorage.getItem(k)!)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  async get(id) {
    const raw = localStorage.getItem("nanpad-doc:" + id);
    if (!raw) throw new Error("文档不存在");
    return withRevision(JSON.parse(raw));
  },
  async save(doc, options) {
    const raw = localStorage.getItem("nanpad-doc:" + doc.id);
    const existing: DocumentAsset | null = raw ? JSON.parse(raw) : null;
    if (doc.createOnly && existing) return withRevision(existing);
    const expectedRevision = options?.expectedRevision ?? doc.revision;
    if (existing && (!expectedRevision || documentRevision(existing) !== expectedRevision))
      throw new DocumentConflictError();
    if (!existing && expectedRevision)
      throw new DocumentConflictError("文档已删除，请另存副本保留本地内容。");
    const { createOnly: _createOnly, revision: _revision, ...content } = doc;
    const next = {
      ...content,
      ...(typeof content.markdown === "string"
        ? { content: markdownContent(content.markdown) }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem("nanpad-doc:" + doc.id, JSON.stringify(next));
    return withRevision(next);
  },
  async remove(id) {
    localStorage.removeItem("nanpad-doc:" + id);
  },
};
function api() {
  return desktop()?.documents ?? (isWeb() ? webDocuments : local);
}
function withRevision(doc: DocumentAsset): DocumentAsset {
  return doc.revision ? doc : { ...doc, revision: documentRevision(doc) };
}
export function summary(doc: DocumentAsset): DocumentSummary {
  const texts: string[] = [];
  let imageCount = 0;
  const walk = (node: JSONContent) => {
    if (node.text) texts.push(node.text);
    if (node.type === "image") imageCount++;
    node.content?.forEach(walk);
  };
  walk(doc.content);
  return {
    id: doc.id,
    title: doc.title,
    bindings: doc.bindings,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    excerpt: texts.join(" ").slice(0, 180),
    imageCount,
  };
}
interface State {
  acceptChange(change: DocumentChange): void;
  list: DocumentSummary[];
  drafts: Record<string, DocumentAsset>;
  savedSummaries: Record<string, DocumentSummary>;
  status: Record<string, "saved" | "saving" | "dirty" | "error">;
  errors: Record<string, string>;
  selected: string | null;
  loaded: boolean;
  load(force?: boolean): Promise<void>;
  open(id: string): Promise<void>;
  create(
    bindings?: AssetRef[],
    initial?: Pick<DocumentAsset, "title" | "content" | "markdown">,
  ): Promise<void>;
  importServer(server: { id: string; name: string; docs?: string }): Promise<void>;
  change(doc: DocumentAsset): void;
  flush(id: string): Promise<void>;
  saveCopy(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Map<string, Promise<void>>();
let loading: Promise<void> | null = null;
let reloadRequested = false;
export const useDocuments = create<State>((set, get) => ({
  list: [],
  drafts: {},
  savedSummaries: {},
  status: {},
  errors: {},
  selected: null,
  loaded: false,
  acceptChange({ document, removedId }) {
    const id = document?.id ?? removedId;
    if (!id) return;
    set((state) => {
      // 自身保存的通知早于响应；正在编辑/保存的草稿由原保存队列收尾。
      if (state.drafts[id] && state.status[id] !== "saved") return state;
      if (document)
        return {
          list: [summary(document), ...state.list.filter((item) => item.id !== id)].sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt),
          ),
          drafts: state.drafts[id] ? { ...state.drafts, [id]: document } : state.drafts,
          savedSummaries: { ...state.savedSummaries, [id]: summary(document) },
        };
      const drafts = { ...state.drafts },
        savedSummaries = { ...state.savedSummaries },
        status = { ...state.status },
        errors = { ...state.errors };
      delete drafts[id];
      delete savedSummaries[id];
      delete status[id];
      delete errors[id];
      return {
        list: state.list.filter((item) => item.id !== id),
        drafts,
        savedSummaries,
        status,
        errors,
        selected: state.selected === id ? null : state.selected,
      };
    });
  },
  async load(force = false) {
    if (loading) {
      if (force) reloadRequested = true;
      return loading;
    }
    if (get().loaded && !force) return;
    let resolveLoad!: () => void;
    let rejectLoad!: (error: unknown) => void;
    const task = new Promise<void>((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    });
    loading = task;
    void (async () => {
      try {
        do {
          reloadRequested = false;
          const before = new Map(get().list.map((doc) => [doc.id, doc]));
          let list: DocumentSummary[];
          try {
            list = await api().list();
          } catch (error) {
            // 请求期间收到保存/删除通知，即使旧请求失败也要补读最新文件。
            if (reloadRequested) continue;
            throw error;
          }
          set((state) => {
            const current = new Map(state.list.map((doc) => [doc.id, doc]));
            const merged = new Map(
              list
                .filter((doc) => !before.has(doc.id) || current.has(doc.id))
                .map((doc) => [doc.id, doc]),
            );
            // 刷新期间新建、删除或编辑的本地文档优先，远端摘要不能覆盖未保存草稿。
            for (const doc of state.list) {
              if (
                before.get(doc.id) !== doc ||
                (state.drafts[doc.id] && state.status[doc.id] !== "saved")
              )
                merged.set(doc.id, doc);
            }
            return {
              list: [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
              loaded: true,
            };
          });
        } while (reloadRequested);
        // 清理与完成处于同一微任务，失效通知不会落进“请求已完成但仍显示在途”的空档。
        loading = null;
        resolveLoad();
      } catch (error) {
        loading = null;
        rejectLoad(error);
      }
    })();
    return task;
  },
  async open(id) {
    const existing = get().selected;
    if (existing && get().status[existing] !== "saved") await get().flush(existing);
    const doc = withRevision(get().drafts[id] ?? (await api().get(id)));
    set((s) => ({
      selected: id,
      drafts: { ...s.drafts, [id]: doc },
      status: { ...s.status, [id]: s.status[id] ?? "saved" },
      savedSummaries: {
        ...s.savedSummaries,
        [id]: s.drafts[id] ? (s.savedSummaries[id] ?? summary(doc)) : summary(doc),
      },
      list: s.list.map((item) => (item.id === id ? summary(doc) : item)),
    }));
  },
  async create(bindings = [], initial) {
    const existing = get().selected;
    if (existing && get().status[existing] !== "saved") await get().flush(existing);
    const now = new Date().toISOString();
    const doc = withRevision(
      await api().save({
        id: "doc-" + randomId(),
        title: initial?.title ?? "未命名文档",
        content: initial?.content ?? { type: "doc", content: [{ type: "paragraph" }] },
        ...(initial?.markdown !== undefined ? { markdown: initial.markdown } : {}),
        bindings,
        createdAt: now,
        updatedAt: now,
      }),
    );
    set((s) => ({
      selected: doc.id,
      drafts: { ...s.drafts, [doc.id]: doc },
      list: [summary(doc), ...s.list.filter((item) => item.id !== doc.id)],
      status: { ...s.status, [doc.id]: "saved" },
      savedSummaries: { ...s.savedSummaries, [doc.id]: summary(doc) },
    }));
  },
  async importServer(server) {
    const existing = get().selected;
    if (existing && get().status[existing] !== "saved") await get().flush(existing);
    const doc = withRevision(await migrateServerDocument(server, api()));
    set((s) => ({
      selected: doc.id,
      drafts: { ...s.drafts, [doc.id]: doc },
      list: [summary(doc), ...s.list.filter((item) => item.id !== doc.id)],
      status: { ...s.status, [doc.id]: "saved" },
      errors: { ...s.errors, [doc.id]: "" },
      savedSummaries: { ...s.savedSummaries, [doc.id]: summary(doc) },
    }));
  },
  change(doc) {
    set((s) => {
      const revision = s.drafts[doc.id]?.revision ?? doc.revision;
      return {
        drafts: {
          ...s.drafts,
          [doc.id]: revision === doc.revision ? doc : { ...doc, revision },
        },
        savedSummaries: {
          ...s.savedSummaries,
          ...(s.savedSummaries[doc.id]
            ? {}
            : { [doc.id]: s.list.find((item) => item.id === doc.id) ?? summary(doc) }),
        },
        status: { ...s.status, [doc.id]: "dirty" },
        list: s.list.map((item) => (item.id === doc.id ? summary(doc) : item)),
      };
    });
    clearTimeout(timers.get(doc.id));
    timers.set(
      doc.id,
      setTimeout(() => {
        void get()
          .flush(doc.id)
          .catch(() => {});
      }, 800),
    );
  },
  async flush(id) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (running.has(id)) return running.get(id)!;
    const save = async () => {
      while (get().status[id] !== "saved") {
        const draft = get().drafts[id];
        if (!draft) return;
        set((s) => ({ status: { ...s.status, [id]: "saving" } }));
        try {
          const saved = withRevision(await api().save(draft, { expectedRevision: draft.revision }));
          if (get().drafts[id] === draft) {
            set((s) => ({
              drafts: { ...s.drafts, [id]: saved },
              status: { ...s.status, [id]: "saved" },
              errors: { ...s.errors, [id]: "" },
              list: s.list.map((item) => (item.id === id ? summary(saved) : item)),
              savedSummaries: { ...s.savedSummaries, [id]: summary(saved) },
            }));
          } else
            set((s) => ({
              drafts: {
                ...s.drafts,
                [id]: { ...s.drafts[id], revision: saved.revision },
              },
              status: { ...s.status, [id]: "dirty" },
              savedSummaries: { ...s.savedSummaries, [id]: summary(saved) },
            }));
        } catch (error) {
          set((s) => ({
            status: { ...s.status, [id]: "error" },
            errors: { ...s.errors, [id]: error instanceof Error ? error.message : String(error) },
          }));
          throw error;
        }
      }
    };
    const job = save().finally(() => running.delete(id));
    running.set(id, job);
    return job;
  },
  async saveCopy(id) {
    if (running.has(id)) throw new Error("文档仍在保存，请稍后再另存副本");
    const draft = get().drafts[id];
    if (!draft) throw new Error("没有可另存的文档草稿");
    const { revision: _revision, ...content } = draft;
    const now = new Date().toISOString();
    const saved = withRevision(
      await api().save({
        ...content,
        id: "doc-" + randomId(),
        title: draft.title + " · 副本",
        createdAt: now,
        updatedAt: now,
        createOnly: true,
      }),
    );
    set((state) => {
      const drafts = { ...state.drafts, [saved.id]: saved };
      const status = { ...state.status, [saved.id]: "saved" as const };
      const errors = { ...state.errors, [saved.id]: "" };
      let list = state.list;
      // 副本落盘后才释放原草稿；另存期间继续输入的内容仍需保留。
      if (state.drafts[id] === draft) {
        clearTimeout(timers.get(id));
        timers.delete(id);
        delete drafts[id];
        delete status[id];
        delete errors[id];
        const original = state.savedSummaries[id];
        if (original) list = list.map((item) => (item.id === id ? original : item));
      }
      return {
        drafts,
        status,
        errors,
        selected: saved.id,
        list: [summary(saved), ...list.filter((item) => item.id !== saved.id)],
        savedSummaries: { ...state.savedSummaries, [saved.id]: summary(saved) },
      };
    });
  },
  async remove(id) {
    await get().flush(id);
    await api().remove(id);
    set((s) => {
      const drafts = { ...s.drafts },
        savedSummaries = { ...s.savedSummaries },
        status = { ...s.status },
        errors = { ...s.errors };
      delete drafts[id];
      delete savedSummaries[id];
      delete status[id];
      delete errors[id];
      return {
        drafts,
        savedSummaries,
        status,
        errors,
        selected: s.selected === id ? null : s.selected,
        list: s.list.filter((x) => x.id !== id),
      };
    });
  },
}));
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (event) => {
    if (Object.values(useDocuments.getState().status).some((s) => s !== "saved")) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

/** 缩放图片后交给内部上传接口；未启用图床时保持本地嵌入。 */
export async function documentImage(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024)
    throw new Error("请选择 8 MiB 以内的 PNG、JPEG 或 WebP 图片");
  inspectRaster(new Uint8Array(await file.arrayBuffer()), file.type);
  const bitmap = await createImageBitmap(file);
  try {
    const ratio = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * ratio);
    canvas.height = Math.round(bitmap.height * ratio);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let data = canvas.toDataURL("image/png");
    while (data.length > 2.6 * 1024 * 1024 && canvas.width > 400 && canvas.height > 400) {
      canvas.width = Math.max(1, Math.round(canvas.width * 0.75));
      canvas.height = Math.max(1, Math.round(canvas.height * 0.75));
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      data = canvas.toDataURL("image/png");
    }
    if (data.length > 2.6 * 1024 * 1024) throw new Error("图片压缩后仍过大，请裁剪后重试");
    return await uploadImage(data, file.name, "document");
  } finally {
    bitmap.close();
  }
}
