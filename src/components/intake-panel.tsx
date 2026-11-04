import { hostBridge } from "@/lib/web-bridge";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowUpRight,
  ClipboardPaste,
  Copy,
  EyeOff,
  Loader2,
  RotateCcw,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import {
  INTAKE_KINDS,
  INTAKE_KIND_NAMES,
  intakeList,
  intakePreset,
  parseMessyText,
  reclassifyEntry,
  refreshSaved,
  setEntryIgnored,
  type IntakeAssetKind,
  type IntakeEntry,
} from "@/lib/messy-intake";
import { useIntakeSession } from "@/lib/intake-session";
import { parsePaste } from "@/lib/parse-paste";
import { useAppStore } from "@/lib/store";
import type { AssetKind } from "@/lib/types";
import { copyText } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";
import { Textarea } from "./ui/input";
import { Select } from "./ui/select";
import "./intake-panel.css";

/**
 * 粘贴一堆杂乱资料，先在本机拆成条目，再按配置的模型补齐字段。
 * 结果可在面板里逐条改类型、忽略噪音；不会自动写入任何资产，用户确认后再决定下一步。
 * 粘贴的内容和结果留在内存里的会话草稿中，关掉面板再打开还在。
 */
export function IntakePanel({
  onAsk,
  onClose,
}: {
  onAsk: (question: string) => void;
  onClose: () => void;
}) {
  const api = hostBridge()?.agent;
  const [busy, setBusy] = useState(false);
  const { text, result, setText, setResult, updateBundle } = useIntakeSession(
    useShallow((s) => ({
      text: s.text,
      result: s.result,
      setText: s.setText,
      setResult: s.setResult,
      updateBundle: s.updateBundle,
    })),
  );
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

  // 结果留着跨视图复用时，资料库可能已经多了一条：把「去录入」换成「打开已有资料」。
  useEffect(() => {
    updateBundle((bundle) => refreshSaved(bundle, snapshot));
  }, [snapshot, updateBundle]);

  const kinds = useMemo(() => {
    if (!result) return [];
    return Object.entries(result.bundle.counts).filter(([, count]) => count > 0);
  }, [result]);
  const ignoredCount = result ? result.bundle.entries.filter((entry) => entry.ignored).length : 0;
  const keptCount = result ? result.bundle.entries.length - ignoredCount : 0;

  /** 手动改类型：按新类型重抽这一条的字段，其他条目原样保留。 */
  function reclassify(index: number, kind: IntakeAssetKind) {
    updateBundle((bundle) => reclassifyEntry(bundle, index, kind, snapshot));
  }

  /** 忽略 / 恢复一条记录：只改 bundle，忽略的条目不计数、不复制、不发给模型。 */
  function setIgnored(index: number, ignored: boolean) {
    updateBundle((bundle) => setEntryIgnored(bundle, index, ignored));
  }

  async function run(useModel: boolean) {
    if (!text.trim()) {
      setError(t("先粘贴一段资料再整理。"));
      return;
    }
    if (text.length > 20000) {
      setError(t("一次最多整理 20000 字符，请分段粘贴。"));
      return;
    }
    // 没有主进程桥时（网页预览）仍然可以按本地规则整理，只是用不了模型。
    if (!api) {
      setResult({
        bundle: parseMessyText(text, snapshot),
        mode: "local",
        model: "",
        error: useModel ? t("粘贴整理需要桌面版或已开启的网页版服务。") : "",
        redacted: 0,
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

  async function readClipboard() {
    if (!navigator.clipboard?.readText) {
      setError(t("这个环境不能读取剪贴板，请手动粘贴。"));
      return;
    }
    try {
      const value = await navigator.clipboard.readText();
      if (!value.trim()) {
        setError(t("剪贴板是空的。"));
        return;
      }
      setText(value);
      setError("");
    } catch {
      setError(t("浏览器没有允许读取剪贴板，请手动粘贴。"));
    }
  }

  function openEntry(entry: IntakeEntry) {
    const state = useAppStore.getState();
    onClose();
    if (entry.saved) {
      if (entry.saved.kind === "phone") state.openPhones({ id: entry.saved.id });
      else state.openComposer(entry.saved.kind as AssetKind, entry.saved.id);
      return;
    }
    if (entry.kind === "phone") {
      state.openPhones({ create: true, draft: intakePreset(entry) });
      return;
    }
    // 表单自己的智能粘贴能认出 API Key、SSH 命令等细节，优先用它的结果。
    const match = parsePaste(entry.line, entry.kind)[0];
    state.openComposer(entry.kind, null, { ...intakePreset(entry), ...(match?.fields ?? {}) });
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
      <p className="intake-count">
        {text.trim().length > 0
          ? t("{0} / 20000 字符", text.length)
          : t("支持一次粘贴 20000 字符以内，每行一条更准。")}
      </p>
      <div className="intake-actions">
        <Button size="sm" disabled={busy} onClick={() => void run(true)}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          {t("AI 整理")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(false)}>
          <Wand2 className="size-4" />
          {t("只按本地规则整理")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void readClipboard()}>
          <ClipboardPaste className="size-4" />
          {t("读取剪贴板")}
        </Button>
        <span className="intake-mode">
          {result
            ? [
                result.model
                  ? t(
                      "{0} · {1}",
                      result.mode === "local" ? t("本机模型") : t("云端模型"),
                      result.model,
                    )
                  : t("本地规则"),
                result.redacted > 0 ? t("已脱敏 {0} 处", result.redacted) : "",
              ]
                .filter(Boolean)
                .join(" · ")
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
            <strong>{t("{0} 条记录", keptCount)}</strong>
            {kinds.map(([kind, count]) => (
              <span key={kind} className="intake-chip">
                {t(INTAKE_KIND_NAMES[kind as keyof typeof INTAKE_KIND_NAMES])}
                <b>{count}</b>
              </span>
            ))}
            {ignoredCount > 0 && (
              <span className="intake-chip intake-chip-ignored">
                {t("已忽略 {0} 条", ignoredCount)}
              </span>
            )}
            {result.bundle.gaps.map((gap) => (
              <span key={gap.label} className="intake-chip intake-chip-gap">
                {t("缺{0}", t(gap.label))}
                <b>{gap.count}</b>
              </span>
            ))}
          </div>
          <ol className="intake-list">
            {result.bundle.entries.map((entry, index) => (
              <EntryCard
                key={entry.id}
                index={index}
                entry={entry}
                onOpen={() => openEntry(entry)}
                onReclassify={(kind) => reclassify(index, kind)}
                onIgnore={() => setIgnored(index, !entry.ignored)}
              />
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

function EntryCard({
  index,
  entry,
  onOpen,
  onReclassify,
  onIgnore,
}: {
  index: number;
  entry: IntakeEntry;
  onOpen: () => void;
  onReclassify: (kind: IntakeAssetKind) => void;
  onIgnore: () => void;
}) {
  const titleId = `intake-entry-title-${index}`;
  const kindOptions = INTAKE_KINDS.map((kind) => ({
    value: kind,
    label: t(INTAKE_KIND_NAMES[kind]),
  }));
  return (
    <li className={entry.ignored ? "intake-entry intake-entry-ignored" : "intake-entry"}>
      <div className="intake-entry-head">
        <Select
          aria-label={t("记录类型")}
          aria-describedby={titleId}
          className="intake-kind-select"
          value={entry.kind}
          onValueChange={(value) => onReclassify(value as IntakeAssetKind)}
          options={kindOptions}
        />
        <strong id={titleId}>{entry.title}</strong>
        {entry.ignored && <span className="intake-chip">{t("已忽略")}</span>}
        {entry.saved && <span className="intake-saved">{t("资料里已有")}</span>}
        {entry.sensitive && <span className="intake-secret">{t("含凭据")}</span>}
      </div>
      <p className="intake-reason">{entry.reason}</p>
      {entry.known.length > 0 && (
        <dl className="intake-fields">
          {entry.known.map((item) => (
            <div key={item.field}>
              <dt>{t(item.label)}</dt>
              <dd>
                {item.value}
                {item.source === "model" && <em className="intake-field-model">{t("模型补充")}</em>}
              </dd>
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
      <div className="intake-entry-actions">
        {entry.ignored ? (
          <Button size="sm" variant="ghost" aria-label={t("恢复这条")} onClick={onIgnore}>
            <RotateCcw className="size-4" aria-hidden="true" />
            {t("恢复这条")}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={onOpen}>
              <ArrowUpRight className="size-4" aria-hidden="true" />
              {entry.saved
                ? t("打开已有资料")
                : entry.kind === "phone"
                  ? t("去号码页添加")
                  : t("去录入")}
            </Button>
            <Button size="sm" variant="ghost" aria-label={t("忽略这条")} onClick={onIgnore}>
              <EyeOff className="size-4" aria-hidden="true" />
              {t("忽略这条")}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
