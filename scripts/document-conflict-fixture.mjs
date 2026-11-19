import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { DocumentsWorkspace } from "../src/components/documents-workspace.tsx";
import { summary, useDocuments } from "../src/lib/documents.ts";
import {
  documentRevision,
  DocumentConflictError,
} from "../electron/services/document-revision.mjs";
import "../src/styles.css";

// 独立内存后端只供按钮回归，不连接桌面服务或用户资料。
export async function mount() {
  const original = {
    id: "doc-ui-conflict",
    title: "原始文档",
    content: { type: "doc", content: [{ type: "paragraph" }] },
    bindings: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const documents = new Map([[original.id, original]]);
  const qa = (window.__documentQa = {
    ready: false,
    copyFails: true,
    copyAttempts: 0,
    state: useDocuments,
    documents,
  });
  const versioned = (doc) => ({ ...doc, revision: documentRevision(doc) });
  window.sinan = {
    documents: {
      list: async () => [...documents.values()].map(summary),
      get: async (id) => versioned(documents.get(id)),
      save: async (doc, options) => {
        if (doc.id !== original.id) {
          qa.copyAttempts++;
          if (qa.copyFails) throw new Error("模拟副本写入失败");
        }
        const existing = documents.get(doc.id);
        if (existing && options?.expectedRevision !== documentRevision(existing))
          throw new DocumentConflictError();
        const { revision: _revision, createOnly: _createOnly, ...content } = doc;
        const saved = { ...content, updatedAt: new Date().toISOString() };
        documents.set(saved.id, saved);
        return versioned(saved);
      },
      remove: async (id) => documents.delete(id),
    },
  };
  useDocuments.setState({
    list: [],
    drafts: {},
    savedSummaries: {},
    status: {},
    errors: {},
    selected: null,
    loaded: false,
  });
  await useDocuments.getState().load();
  await useDocuments.getState().open(original.id);
  documents.set(original.id, { ...original, title: "其他设备的新内容" });
  useDocuments.getState().change({
    ...useDocuments.getState().drafts[original.id],
    title: "本地未保存草稿",
  });
  try {
    await useDocuments.getState().flush(original.id);
  } catch (error) {
    if (!(error instanceof DocumentConflictError)) throw error;
  }
  document.documentElement.dataset.theme = "light";
  createRoot(document.getElementById("root")).render(
    h(
      "main",
      { className: "min-h-screen p-4", "data-app-ready": "true" },
      h(DocumentsWorkspace),
      h(Toaster),
    ),
  );
  qa.ready = true;
}
