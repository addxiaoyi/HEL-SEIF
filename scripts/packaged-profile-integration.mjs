import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { WINDOWS_TOAST_CLSID } from "../electron/services/windows-identity.mjs";

const [executable, directoryArg, mode = "roundtrip"] = process.argv.slice(2);
assert.ok(executable, "请指定打包程序。");
assert.ok(["seed", "verify", "roundtrip"].includes(mode), "无效的测试阶段。");
const splitProfile = process.env.HELSELF_QA_SPLIT_PROFILE === "1";
if (splitProfile)
  await access(
    join(dirname(resolve(executable)), "resources/windows-shell/Helself.WindowsShell.exe"),
  );
const directory = directoryArg
  ? resolve(directoryArg)
  : await mkdtemp(join(tmpdir(), "helself-profile-"));
const env = { ...process.env };
for (const key of ["ELECTRON_RUN_AS_NODE", "SINAN_DEV_URL", "NANPAD_TEST_DATA_DIR"])
  delete env[key];
let instance;

async function launch() {
  instance = await electron.launch({
    executablePath: resolve(executable),
    args: splitProfile ? ["--user-data-dir", directory] : [`--user-data-dir=${directory}`],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  assert.equal(await instance.evaluate(({ app }) => app.isPackaged), true);
  const page = await instance.firstWindow();
  if (
    process.platform === "win32" &&
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted"
  ) {
    const nativeToast = await instance.evaluate(async ({ app, Notification }) => {
      const supported = Notification.isSupported();
      await new Promise((resolve) => setTimeout(resolve, 750));
      return { supported, toastClsid: app.toastActivatorCLSID };
    });
    assert.equal(nativeToast.supported, true, "一次性 Windows runner 应能初始化原生通知");
    const guid = (value) => value.replace(/[{}]/g, "").toLowerCase();
    assert.equal(guid(nativeToast.toastClsid), guid(WINDOWS_TOAST_CLSID));
    console.log(JSON.stringify({ nativeToast }));
  }
  await instance.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  return page;
}

try {
  if (mode !== "verify") {
    await writeFile(join(directory, ".helself-qa-profile"), "synthetic installation regression\n");
    await writeFile(
      join(directory, "local-usage.json"),
      JSON.stringify({ version: 1, enabled: false, events: [], checkpoints: [], records: [] }),
    );
    const page = await launch();
    await completeOnboarding(page);
    await page.locator('[data-app-ready="true"]').waitFor();
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      await window.sinan.documents.save({
        id: "doc-qa-upgrade",
        title: "升级保留验证",
        bindings: [],
        createdAt: now,
        updatedAt: now,
        content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "synthetic upgrade content" }] },
          ],
        },
      });
      await window.sinan.vault.set("qa-upgrade-account", { password: "synthetic-upgrade-secret" });
      await window.sinan.preferences.set({
        reminderDays: 14,
        notifications: false,
        closeToTray: false,
      });
    });
    await instance.close();
    instance = null;
  }
  if (mode !== "seed") {
    assert.equal(
      await readFile(join(directory, ".helself-qa-profile"), "utf8"),
      "synthetic installation regression\n",
    );
    const page = await launch();
    await page.locator('[data-app-ready="true"]').waitFor();
    const preserved = await page.evaluate(async () => {
      await window.sinan.vault.unlock("integration-master-2026");
      return {
        document: (await window.sinan.documents.list()).some(
          (doc) => doc.id === "doc-qa-upgrade" && doc.title === "升级保留验证",
        ),
        secret:
          (await window.sinan.vault.get("qa-upgrade-account"))?.password ===
          "synthetic-upgrade-secret",
        reminderDays: (await window.sinan.preferences.get()).reminderDays,
        localMonitoring: (await window.sinan.usage.localStatus()).enabled,
      };
    });
    assert.deepEqual(preserved, {
      document: true,
      secret: true,
      reminderDays: 14,
      localMonitoring: false,
    });
    console.log(JSON.stringify({ ok: true, mode, packaged: true, preserved }));
  } else console.log(JSON.stringify({ ok: true, mode, packaged: true }));
} finally {
  await instance?.close();
  if (!directoryArg)
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
