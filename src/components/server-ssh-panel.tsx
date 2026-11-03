import {
  CheckCircle2,
  Fingerprint,
  KeyRound,
  Loader2,
  Pencil,
  RotateCcw,
  ShieldAlert,
  SquareTerminal,
  Unlock,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { credentialId, type CredentialKind } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import type { Server } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { vaultApi } from "@/lib/vault-api";
import { useVault } from "@/lib/vault-state";
import { isWeb } from "@/lib/web";
import { hostBridge } from "@/lib/web-bridge";

const KIND_LABEL: Record<CredentialKind, string> = {
  password: "密码",
  key: "私钥",
  agent: "Agent",
};

type FingerprintState =
  | { state: "loading" }
  | { state: "locked" }
  | { state: "ready"; value: string | null }
  | { state: "error"; message: string };

/**
 * SSH credentials for one saved host.
 *
 * The desktop app has always had the form in the asset editor, but a changed
 * host key is reported while connecting — with no panel in sight on the web
 * build. This tab puts the saved credential, the pinned fingerprint and the
 * deliberate reset in one place, so the message in a failed connection has
 * somewhere to point at.
 */
export function ServerSshPanel({ server }: { server: Server }) {
  const bridge = hostBridge();
  const vault = vaultApi();
  const unlocked = useVault((s) => s.unlocked);
  const openComposer = useAppStore((s) => s.openComposer);
  const openSsh = useAppStore((s) => s.openSsh);
  const [stored, setStored] = useState<CredentialKind | null | "unknown">("unknown");
  const [fingerprint, setFingerprint] = useState<FingerprintState>({ state: "loading" });
  const [test, setTest] = useState<{ state: "idle" | "busy" | "ok" | "fail"; message?: string }>({
    state: "idle",
  });
  const [resetting, setResetting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const configured = server.sshConfigured !== false;
  const fingerprintChanged =
    test.state === "fail" && (test.message ?? "").includes("主机指纹已变更");

  useEffect(() => {
    let alive = true;
    // Only the kind is read back; the form never paints the stored secret.
    void (async () => {
      if (!vault || !unlocked) {
        if (alive) setStored("unknown");
        return;
      }
      try {
        const credential = await vault.get(credentialId(server.id));
        if (alive) setStored(credential?.kind ?? null);
      } catch {
        if (alive) setStored("unknown");
      }
    })();
    return () => {
      alive = false;
    };
  }, [vault, unlocked, server.id, refresh]);

  useEffect(() => {
    if (!bridge || !server.host) return;
    // On the desktop the pin lives in the encrypted vault; the web server keeps
    // it in its own known-hosts file, so it stays readable while the vault is locked.
    if (!isWeb() && !unlocked) {
      setFingerprint({ state: "locked" });
      return;
    }
    let alive = true;
    setFingerprint({ state: "loading" });
    void bridge.ssh.hostKey({ host: server.host, port: server.port }).then(
      (result) => {
        if (alive) setFingerprint({ state: "ready", value: result.fingerprint });
      },
      (error) => {
        if (!alive) return;
        const message = error instanceof Error ? error.message : String(error);
        setFingerprint(
          message.includes("密钥库已锁定") ? { state: "locked" } : { state: "error", message },
        );
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge, server.host, server.port, unlocked, refresh]);

  const requireVault = useCallback(async (reason: string) => {
    if (await useVault.getState().require(reason)) return true;
    setTest({ state: "fail", message: t("密钥库未解锁") });
    return false;
  }, []);

  async function runTest() {
    const api = bridge?.ssh;
    if (!api) return;
    if (!(await requireVault(t("测试连接需要先解锁密钥库。")))) return;
    setTest({ state: "busy" });
    try {
      const result = await api.testStored({
        id: server.id,
        host: server.host,
        port: server.port || 22,
        username: server.username,
      });
      setTest({ state: "ok", message: result.message });
    } catch (error) {
      setTest({
        state: "fail",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // A first successful connection pins the key; a change leaves the old pin.
      setRefresh((value) => value + 1);
    }
  }

  async function resetFingerprint() {
    const api = bridge?.ssh;
    if (!api || !server.host) return;
    if (!(await requireVault(t("重置主机指纹需要先解锁密钥库。")))) return;
    const confirmed = window.confirm(
      t(
        "确认服务器已经重装或更换过主机密钥。\n\n重置后，{0}:{1} 下一次连接会重新记录并信任服务器出示的指纹。如果连接正被劫持，这会把攻击者放行。",
        server.host,
        server.port || 22,
      ),
    );
    if (!confirmed) return;
    setResetting(true);
    try {
      await api.resetHostKey({ host: server.host, port: server.port });
      setTest({ state: "idle" });
      setRefresh((value) => value + 1);
      toast.success(t("已重置主机指纹，下一次连接会重新记录。"));
    } catch (error) {
      setTest({
        state: "fail",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setResetting(false);
    }
  }

  if (!configured) {
    return (
      <div className="space-y-3 px-4 py-4">
        <header>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="size-4" />
            {t("SSH 凭据")}
          </h3>
          <p className="mt-2 text-sm text-muted">
            {t("这台主机只记录信息，尚未配置 SSH。配置后可在此查看主机指纹并测试连接。")}
          </p>
        </header>
        <Button type="button" size="sm" onClick={() => openComposer("server", server.id)}>
          <Pencil className="size-3.5" />
          {t("配置 SSH")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 px-4 py-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="size-4" />
            {t("SSH 凭据")}
          </h3>
          <p className="mt-1 font-mono text-xs text-muted">
            {server.username}@{server.host}:{server.port || 22}
          </p>
        </div>
        <span className="rounded-full border border-line px-2 py-0.5 text-2xs text-subtle">
          {stored === "unknown"
            ? unlocked
              ? t("未读取")
              : t("密钥库已锁定")
            : stored
              ? t("已保存（{0}）", t(KIND_LABEL[stored]))
              : t("尚未保存")}
        </span>
      </header>

      <section className="rounded-xl border border-line p-4">
        <h4 className="flex items-center gap-2 text-meta font-semibold">
          <Fingerprint className="size-3.5 text-muted" />
          {t("主机指纹")}
        </h4>
        <p className="mt-2 break-all font-mono text-xs text-ink">
          {fingerprint.state === "loading"
            ? t("正在读取…")
            : fingerprint.state === "locked"
              ? t("解锁密钥库后查看")
              : fingerprint.state === "error"
                ? fingerprint.message
                : (fingerprint.value ?? t("尚未记录，首次连接时会自动记录。"))}
        </p>
        <p className="mt-2 text-2xs leading-relaxed text-subtle">
          {t(
            "首次连接采用信任记录：之后服务器必须出示同一把主机密钥，否则连接会被拒绝。更换主机或重装系统后，需要在这里确认新指纹。",
          )}
        </p>
        {fingerprint.state === "locked" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => void useVault.getState().require(t("查看主机指纹需要先解锁密钥库。"))}
          >
            <Unlock className="size-3.5" />
            {t("解锁密钥库")}
          </Button>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={test.state === "busy"}
          onClick={() => void runTest()}
        >
          {test.state === "busy" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ShieldAlert className="size-3.5" />
          )}
          {t("测试连接")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={resetting}
          onClick={() => void resetFingerprint()}
        >
          {resetting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCcw className="size-3.5" />
          )}
          {t("重置主机指纹")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => openComposer("server", server.id)}
        >
          <Pencil className="size-3.5" />
          {t("编辑凭据")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => openSsh(server.id)}>
          <SquareTerminal className="size-3.5" />
          {t("打开终端")}
        </Button>
      </div>

      {test.message && (
        <p
          role={test.state === "fail" ? "alert" : "status"}
          className={
            test.state === "ok"
              ? "flex items-start gap-1.5 break-words text-xs text-ok"
              : "flex items-start gap-1.5 break-words text-xs text-crit"
          }
        >
          {test.state === "ok" ? (
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <XCircle className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span>{test.message}</span>
        </p>
      )}
      {fingerprintChanged && (
        <p className="text-2xs leading-relaxed text-subtle">
          {t(
            "请先在服务器上核对主机公钥（ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub），确认无误后再重置指纹。",
          )}
        </p>
      )}

      <p className="text-2xs leading-relaxed text-subtle">
        {t(
          "凭据用主密码派生的密钥加密后单独存放，不写入资产文件；网页版在浏览器里解密后随请求发送，服务器不保存。",
        )}
      </p>
    </div>
  );
}
