import { vaultApi } from "@/lib/vault-api";
import { Eye, EyeOff, KeyRound, Trash2, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Field, Input, Textarea } from "./ui/input";
import { accountId } from "@/lib/desktop";
import { ACCOUNT_KEYS } from "@/lib/account-record.mjs";
import type { AssetKind } from "@/lib/types";
import { useVault } from "@/lib/vault-state";
import { t } from "@/lib/i18n";

import { ACCOUNT_COPY, STANDALONE_ACCOUNT_COPY, WEBSITE_ACCOUNT_COPY } from "@/lib/account-copy";

/**
 * Account fields inside the composer.
 *
 * Nothing here reaches the asset record: on save the composer writes this to
 * the vault under `account:<id>`. When the vault is open the existing values
 * are read back so editing is editing rather than retyping.
 */
export function AccountFields({
  assetId,
  kind,
  form,
  set,
}: {
  assetId: string | null;
  kind: AssetKind;
  form: Record<string, string>;
  set: (key: string, value: string) => void;
}) {
  const vault = vaultApi();
  const unlocked = useVault((s) => s.unlocked);
  const requireVault = useVault((s) => s.require);
  const [reveal, setReveal] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [stored, setStored] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const current = useRef({ form, set });
  current.current = { form, set };
  const standalone = kind === "secret" && form.kind === "account";
  const website = kind === "secret" && form.kind === "password";
  const copy = standalone
    ? STANDALONE_ACCOUNT_COPY
    : website
      ? WEBSITE_ACCOUNT_COPY
      : ACCOUNT_COPY[kind];

  useEffect(() => {
    setLoaded(false);
    setStored(false);
    setReveal(false);
    setLoadError(false);
  }, [assetId, unlocked]);

  // Prefill once per open, and only from an unlocked vault.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!vault || !assetId || !unlocked || loaded) return;
      try {
        const rec = await vault.get(accountId(assetId));
        if (!alive) return;
        setLoaded(true);
        if (!rec) return;
        setStored(true);
        // 只有表单里从未出现过的键才回填：用户抢先输入的值不能被迟到的
        // 密钥库记录覆盖（异步预填与手输竞争时以手输为准）。
        const { form: latest, set: update } = current.current;
        if (rec.url && !("_url" in latest)) update("_url", rec.url);
        if (rec.username && !("_username" in latest)) update("_username", rec.username);
        if (!standalone && rec.password && !("_password" in latest))
          update("_password", rec.password);
        if (rec.note && !("_note" in latest)) update("_note", rec.note);
      } catch {
        if (alive) {
          setLoaded(true);
          setLoadError(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [vault, assetId, unlocked, loaded, standalone]);

  if (!vault)
    return standalone ? (
      <p className="rounded-xl bg-canvas p-4 text-meta text-muted sm:col-span-2">
        {t("浏览器预览没有加密密钥库，不会保存账号凭据；请使用桌面版或自托管网页版。")}
      </p>
    ) : null;

  return (
    <div className="sm:col-span-2">
      <div className="rounded-xl bg-canvas p-4">
        <div className="mb-3 flex items-center gap-2">
          <UserRound className="size-4 text-muted" />
          <h3 className="text-meta font-semibold">{t(copy.title)}</h3>
          <span className="ml-auto text-2xs text-subtle">
            {!unlocked
              ? t("密钥库已锁定")
              : assetId && !loaded
                ? t("读取中…")
                : stored
                  ? t("已保存")
                  : t("尚未保存")}
          </span>
        </div>

        {!unlocked ? (
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void requireVault(t("查看或保存账号密码需要先解锁密钥库。"))}
            >
              <KeyRound className="size-3.5" />

              {t("解锁密钥库")}
            </Button>
            <span className="text-2xs text-muted">
              {t("解锁后可读取已保存的账号，或录入新的。")}
            </span>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2" aria-busy={Boolean(assetId) && !loaded}>
            {/* 编辑已存在资产时，密钥库记录异步读取期间字段短暂为空；
                禁用并提示，避免被误读成“密码没保存”。 */}
            <fieldset
              disabled={Boolean(assetId) && !loaded}
              className="contents"
              aria-label={t("账号信息")}
            >
              {(kind !== "secret" || website || standalone) && (
                <>
                  <Field label={t(standalone ? "登录网址" : "登录地址")}>
                    <Input
                      name="account-url"
                      aria-label={t(standalone ? "登录网址" : "登录地址")}
                      value={form._url ?? ""}
                      placeholder="https://…"
                      autoComplete="off"
                      onChange={(e) => set("_url", e.target.value)}
                    />
                  </Field>
                  <Field label={t(standalone ? "账户名" : "账号")}>
                    <Input
                      name="account-username"
                      aria-label={t(standalone ? "账户名" : "账号")}
                      required={standalone}
                      value={form._username ?? ""}
                      autoComplete="off"
                      onChange={(e) => set("_username", e.target.value)}
                    />
                  </Field>
                </>
              )}

              <div className="sm:col-span-2">
                <Field label={t(copy.password)}>
                  <div className="relative">
                    <Input
                      type={reveal ? "text" : "password"}
                      name="account-password"
                      aria-label={t(copy.password)}
                      value={form._password ?? ""}
                      autoComplete="off"
                      required={standalone && !stored}
                      placeholder={standalone && stored ? t("留空保留已保存的密码") : undefined}
                      spellCheck={false}
                      className="pr-10 font-mono"
                      onChange={(e) => set("_password", e.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={reveal ? t("隐藏") : t("显示")}
                      className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-subtle transition-colors duration-150 ease-out hover:bg-line hover:text-ink"
                      onClick={() => setReveal((v) => !v)}
                    >
                      {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </Field>
              </div>

              <div className="sm:col-span-2">
                <Field label={t(standalone ? "敏感备注" : "备注（恢复码 / 授权码 / 二次验证）")}>
                  <Textarea
                    name="account-note"
                    aria-label={t(standalone ? "敏感备注" : "备注（恢复码 / 授权码 / 二次验证）")}
                    value={form._note ?? ""}
                    spellCheck={false}
                    className="min-h-20 font-mono text-2xs"
                    onChange={(e) => set("_note", e.target.value)}
                  />
                </Field>
              </div>

              {loadError && (
                <p role="alert" className="text-2xs text-crit sm:col-span-2">
                  {t("账号信息读取失败，请重新打开后重试。")}
                </p>
              )}
              {standalone && stored && (
                <p className="text-2xs text-muted sm:col-span-2">{t("留空保留已保存的密码")}</p>
              )}
              {stored && assetId && !standalone && (
                <div className="sm:col-span-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-crit"
                    onClick={async () => {
                      try {
                        await vault.remove(accountId(assetId));
                        setStored(false);
                        for (const key of ACCOUNT_KEYS) set(key, "");
                        toast(t("已删除保存的账号信息"));
                      } catch (error) {
                        toast.error(error instanceof Error ? error.message : t("凭据保存失败"));
                      }
                    }}
                  >
                    <Trash2 className="size-3.5" />

                    {t("删除已保存的账号")}
                  </Button>
                </div>
              )}
            </fieldset>
          </div>
        )}

        <p className="mt-3 text-2xs leading-relaxed text-subtle">{t(copy.hint)}</p>
      </div>
    </div>
  );
}
