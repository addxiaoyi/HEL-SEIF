import { hostBridge } from "@/lib/web-bridge";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ClipboardPaste, Copy, Loader2, Sparkles, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import {
  INTAKE_KIND_NAMES,
  intakeList,
  parseMessyText,
  type IntakeBundle,
  type IntakeEntry,
} from "@/lib/messy-intake";
import { useAppStore } from "@/lib/store";
import { copyText } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";
import { Textarea } from "./ui/input";
import "./intake-panel.css";

/**
 * 粘贴一堆杂乱资料，先在本机拆成条目，再按配置的模型补齐字段。
 * 结果只读展示：不写入任何资产，用户确认后再自己决定下一步。
 */
export function IntakePanel({
  onAsk,
  onClose,
}: {
  onAsk: (question: string) => void;
  onClose: () => void;
}) {
  const api = hostBridge()?.agent;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    bundle: IntakeBundle;
    mode: string;
    model: string;
    error: string;
  } | null>(null);
  const [error, setError] = useState("");
  const snapshot = useAppStore(
    useShallow((s) => ({
      servers: s.servers,
      domains: s.domains,
      services: s.services,
      phoneNumbers: s.phoneNumbers,
      aiAssets: s.aiAssets,
      certs: s.certs,
      mailboxes: s.mailboxes,
    })),
  );

  const kinds = useMemo(() => {
    if (!result) return [];
    return Object.entries(result.bundle.counts).filter(([, count]) => count > 0);
  }, [result]);

  async function run(useModel: boolean) {
    if (!text.trim()) {
      setError(t("先粘贴一段资料再整理。"));
      return;
    }
    // 没有主进程桥时（网页预览）仍然可以按本地规则整理，只是用不了模型。
    if (!api) {
      setResult({
        bundle: parseMessyText(text, snapshot),
        mode: "local",
        model: "",
        error: useModel ? t("粘贴整理需要桌面版或已开启的网页版服务。") : "",
      });
      setError(useModel ? t("粘贴整理需要桌面版或已开启的网页版服务。") : "");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const parsed = await api.parseIntake({ text, useModel });
      setResult(parsed);
      if (parsed.error) setError(parsed.error);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function ask() {
    if (!result) return;
    onAsk(
      t(
        "这是我粘贴整理后的结果。请对照已保存的资料，逐项告诉我哪些需要更新、哪些是新的，并给出可审阅的修改建议；资料里判断不了的先问我。\n\n{0}",
        intakeList(result.bundle),
      ),
    );
    onClose();
  }

  return (
    <div className="intake-panel">
      <p className="intake-hint">
        {t(
          "把账单、聊天记录、表格里抄出来的资料整段粘进来，每行一条也行。本地先拆成条目，再加上模型补充的字段；不会自动写入任何资料。",
        )}
      </p>
      <Textarea
        aria-label={t("粘贴的杂乱资料")}
        className="intake-input"
        value={text}
        placeholder={t(
          "例如：\n阿里云 47.100.1.2 root 密码 xxxx 到期 2026-05-01 ¥99/月\nexample.com 注册商 阿里云 到期 2026-08-12 ¥55/年",
        )}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="intake-actions">
        <Button size="sm" disabled={busy} onClick={() => void run(true)}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          {t("AI 整理")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(false)}>
          <Wand2 className="size-4" />
          {t("只按本地规则整理")}
        </Button>
        <span className="intake-mode">
          {result
            ? result.model
              ? t(
                  "{0} · {1}",
                  result.mode === "local" ? t("本机模型") : t("云端模型"),
                  result.model,
                )
              : t("本地规则")
            : t("先整理再决定要不要写入")}
        </span>
      </div>
      {error && (
        <p role="alert" className="intake-error">
          {error}
        </p>
      )}
      {result && (
        <div className="intake-result">
          <div className="intake-summary">
            <strong>{t("{0} 条记录", result.bundle.entries.length)}</strong>
            {kinds.map(([kind, count]) => (
              <span key={kind} className="intake-chip">
                {t(INTAKE_KIND_NAMES[kind as keyof typeof INTAKE_KIND_NAMES])}
                <b>{count}</b>
              </span>
            ))}
            {result.bundle.gaps.map((gap) => (
              <span key={gap.label} className="intake-chip intake-chip-gap">
                {t("缺{0}", t(gap.label))}
                <b>{gap.count}</b>
              </span>
            ))}
          </div>
          <ol className="intake-list">
            {result.bundle.entries.map((entry) => (
              <EntryCard key={entry.id} entry={entry} />
            ))}
          </ol>
          <div className="intake-actions">
            <Button size="sm" onClick={ask}>
              <Sparkles className="size-4" />
              {t("让 AI 接着处理")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void copyText(intakeList(result.bundle)).then(
                  () => toast.success(t("整理结果已复制。")),
                  (reason: unknown) =>
                    toast.error(reason instanceof Error ? reason.message : String(reason)),
                )
              }
            >
              <Copy className="size-4" />
              {t("复制结果")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setResult(null);
                setError("");
              }}
            >
              <Trash2 className="size-4" />
              {t("清空结果")}
            </Button>
          </div>
        </div>
      )}
      {!result && text.trim() && (
        <p className="intake-ready">
          <ClipboardPaste className="size-4" aria-hidden="true" />
          {t("已粘贴 {0} 个字符，点上面的按钮开始整理。", text.trim().length)}
        </p>
      )}
    </div>
  );
}

function EntryCard({ entry }: { entry: IntakeEntry }) {
  return (
    <li className="intake-entry">
      <div className="intake-entry-head">
        <span className={`intake-kind intake-kind-${entry.kind}`}>
          {t(INTAKE_KIND_NAMES[entry.kind])}
        </span>
        <strong>{entry.title}</strong>
        {entry.saved && <span className="intake-saved">{t("资料里已有")}</span>}
        {entry.sensitive && <span className="intake-secret">{t("含凭据")}</span>}
      </div>
      <p className="intake-reason">{entry.reason}</p>
      {entry.known.length > 0 && (
        <dl className="intake-fields">
          {entry.known.map((item) => (
            <div key={item.field}>
              <dt>{t(item.label)}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {entry.inferred.length > 0 && (
        <dl className="intake-fields intake-fields-inferred">
          {entry.inferred.map((item) => (
            <div key={item.field}>
              <dt>{t(item.label)}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {entry.missing.length > 0 && (
        <p className="intake-missing">
          {t("还缺：{0}", entry.missing.map((item) => t(item)).join("、"))}
        </p>
      )}
      {entry.questions.length > 0 && (
        <ul className="intake-questions">
          {entry.questions.map((question) => (
            <li key={question}>{question}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
