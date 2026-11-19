import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { IntakePanel } from "../src/components/intake-panel.tsx";
import { parseMessyText } from "../src/lib/messy-intake.ts";
import { useIntakeSession } from "../src/lib/intake-session.ts";
import "../src/styles.css";

// 合成的慢请求由浏览器测试手动结束，不连接模型或读取私人资料。
export function mount() {
  const requests = [];
  const qa = (window.__intakeQa = {
    requests,
    complete(index) {
      const request = requests[index];
      if (!request) throw new Error(`Unknown intake request: ${index}`);
      request.resolve({
        bundle: parseMessyText(request.text),
        mode: "local",
        model: "synthetic-model",
        error: "",
        redacted: 0,
      });
    },
    fail(index) {
      const request = requests[index];
      if (!request) throw new Error(`Unknown intake request: ${index}`);
      request.reject(new Error("合成模型请求失败"));
    },
    session: useIntakeSession,
  });
  window.sinan = {
    agent: {
      parseIntake: ({ text }) =>
        new Promise((resolve, reject) => requests.push({ text, resolve, reject })),
    },
  };
  useIntakeSession.getState().setResult(null);
  useIntakeSession.getState().setText("");
  document.documentElement.dataset.theme = "light";

  function Harness() {
    const [open, setOpen] = useState(true);
    function togglePanel() {
      setOpen((current) => !current);
    }
    function closePanel() {
      setOpen(false);
    }
    function ask(question) {
      qa.question = question;
    }
    return h(
      "main",
      { className: "min-h-screen p-4", "data-app-ready": "true" },
      h("button", { type: "button", onClick: togglePanel }, "切换整理面板"),
      open ? h(IntakePanel, { onAsk: ask, onClose: closePanel }) : null,
      h(Toaster),
    );
  }

  createRoot(document.getElementById("root")).render(h(Harness));
}
