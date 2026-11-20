import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Use a GitHub-hosted Windows runner");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.platform, "win32");

const [executable, output, phase] = process.argv.slice(2);
assert.ok(executable && output && ["seed", "verify"].includes(phase));
const appVersion = phase === "seed" ? "1.17.3" : "1.17.13";
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !["ELECTRON_RUN_AS_NODE", "SINAN_DEV_URL", "NANPAD_TEST_DATA_DIR"].includes(key),
  ),
);
const app = await electron.launch({
  executablePath: resolve(executable),
  env,
  locale: "zh-CN",
  timeout: 45000,
});

const workspace = "Historical upgrade fixture";
const master = "fixture-only-master-password";
const docId = "doc-historical-upgrade-fixture";
const docTitle = "Historical upgrade fixture document";
const docText = "Persisted by the original 1.17.3 release";
const vaultId = "historical-upgrade-fixture-account";
const password = "fixture-only-vault-entry";
const reminderDays = 14;

try {
  const runtime = await app.evaluate(({ app: electronApp }) => ({
    version: electronApp.getVersion(),
    packaged: electronApp.isPackaged,
    userData: electronApp.getPath("userData"),
  }));
  assert.equal(runtime.version, appVersion);
  assert.equal(runtime.packaged, true);
  assert.equal(runtime.userData.toLowerCase(), join(env.APPDATA, "Nanpad").toLowerCase());

  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );

  if (phase === "seed") {
    await page.getByRole("textbox", { name: "工作区名称", exact: true }).fill(workspace);
    await page.getByRole("textbox", { name: "主密码", exact: true }).fill(master);
    await page.getByRole("textbox", { name: "确认主密码", exact: true }).fill(master);
    await page.getByRole("button", { name: "进入知屿", exact: true }).click();
  }
  await page.locator('[data-app-ready="true"]').waitFor({ timeout: 45000 });
  await page.getByRole("dialog", { name: "首次设置" }).waitFor({ state: "detached" });

  if (phase === "seed") {
    await page.evaluate(
      async ({ docId, docTitle, docText, vaultId, password, reminderDays }) => {
        const now = new Date().toISOString();
        await window.sinan.documents.save({
          id: docId,
          title: docTitle,
          bindings: [],
          createdAt: now,
          updatedAt: now,
          content: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: docText }] }],
          },
        });
        await window.sinan.vault.set(vaultId, { password });
        await window.sinan.preferences.set({ reminderDays, notifications: false, closeToTray: false });
        await window.sinan.usage.configureLocal({ enabled: false });
      },
      { docId, docTitle, docText, vaultId, password, reminderDays },
    );
  }

  const retained = await page.evaluate(
    async ({ docId, docTitle, docText, vaultId, password, workspace, master }) => {
      await window.sinan.vault.unlock(master);
      const doc = await window.sinan.documents.get(docId);
      const preferences = await window.sinan.preferences.get();
      const profile = await window.sinan.profile.get();
      return {
        displayName: profile.ready && profile.name === workspace,
        document: doc?.title === docTitle && doc.content?.content?.[0]?.content?.[0]?.text === docText,
        vault: (await window.sinan.vault.get(vaultId))?.password === password,
        reminderDays: preferences.reminderDays,
        notifications: preferences.notifications,
        closeToTray: preferences.closeToTray,
        localMonitoring: (await window.sinan.usage.localStatus()).enabled,
      };
    },
    { docId, docTitle, docText, vaultId, password, workspace, master },
  );
  await page.screenshot({ path: join(output, `workspace-${phase}.png`), timeout: 15000 });
  const evidence = { phase, ...runtime, retained, pageErrors: errors };
  await writeFile(join(output, `workspace-${phase}.json`), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
  assert.deepEqual(errors, []);
  assert.deepEqual(retained, {
    displayName: true,
    document: true,
    vault: true,
    reminderDays,
    notifications: false,
    closeToTray: false,
    localMonitoring: false,
  });
} finally {
  await app.close();
}
