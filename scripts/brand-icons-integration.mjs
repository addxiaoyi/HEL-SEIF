import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

// 使用真正的打包程序，防止仅检查 PNG 文件却遗漏界面灰度和 Electron 默认图标。
const directory = await mkdtemp(join(tmpdir(), "helself-brand-"));
// 明确关闭隔离样本的真实日志扫描；监控功能另用合成日志测试。
await writeFile(
  join(directory, "local-usage.json"),
  JSON.stringify({ version: 1, enabled: false, checkpoints: [], events: [], records: [] }),
);
let instance;
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SINAN_DEV_URL;
  delete env.NANPAD_TEST_DATA_DIR;
  instance = await electron.launch({
    executablePath: resolve(process.argv[2]),
    args: [`--user-data-dir=${directory}`],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  assert.equal(await instance.evaluate(({ app }) => app.getPath("sessionData")), directory);
  assert.equal(await instance.evaluate(({ app }) => app.getName()), "Helself");
  const page = await instance.firstWindow();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  assert.equal((await page.evaluate(() => window.sinan.usage.localStatus())).enabled, false);
  await mkdir("screenshots", { recursive: true });
  const colors = [];
  for (const theme of ["light", "dark"]) {
    if ((await page.locator("html").getAttribute("data-theme")) !== theme)
      await page.getByRole("button", { name: "切换主题外观", exact: true }).click();
    await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
    // 透明标记：立柱跟随文字颜色，核心是固定品牌亮绿（见 src/lib/brand-mark.mjs）。
    const logo = page.locator("[data-brand-mark]").first();
    const fills = await logo
      .locator("rect, circle")
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fill));
    const chromatic = fills.some((fill) => {
      const channels =
        fill
          .match(/[\d.]+/g)
          ?.slice(0, 3)
          .map(Number) ?? [];
      return channels.length === 3 && Math.max(...channels) - Math.min(...channels) >= 35;
    });
    assert.ok(chromatic, `${theme} 主题 Logo 应保留品牌亮绿核心，实际为 ${fills.join(", ")}`);
    const frame = fills[0];
    const frameChannels =
      frame
        .match(/[\d.]+/g)
        ?.slice(0, 3)
        .map(Number) ?? [];
    const frameLuma = frameChannels.reduce((sum, value) => sum + value, 0) / frameChannels.length;
    assert.ok(
      theme === "light" ? frameLuma < 110 : frameLuma > 150,
      `${theme} 主题立柱应跟随主题文字颜色，实际为 ${frame}`,
    );
    colors.push({ theme, fills });
    await page.screenshot({
      path: `screenshots/helself-brand-${theme}.png`,
      animations: "disabled",
    });
  }
  assert.equal(process.platform, "win32", "此检查针对 Windows 正式安装包");
  const executable = await instance.evaluate(() => process.execPath);
  const executableIcon = JSON.parse(
    execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        resolve("scripts/windows-icon-check.ps1"),
        "-IconPath",
        executable,
        "-OutputPng",
        resolve("screenshots/helself-executable-icon.png"),
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
  assert.equal(executableIcon.ok, true);
  const windowIdentity = await instance.evaluate(({ BrowserWindow }) => ({
    handle: BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE(0).toString(),
    resources: process.resourcesPath,
  }));
  const taskbar = JSON.parse(
    execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        resolve("scripts/windows-taskbar-check.ps1"),
        "-WindowHandle",
        windowIdentity.handle,
        "-ExpectedAppId",
        "dev.helself.app",
        "-ExpectedIconPath",
        join(windowIdentity.resources, "helself.ico"),
        "-ExpectedExecutable",
        executable,
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
  assert.equal(taskbar.ok, true);
  const windowIcon = JSON.parse(
    execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        resolve("scripts/windows-icon-check.ps1"),
        "-IconPath",
        executable,
        "-WindowHandle",
        windowIdentity.handle,
        "-OutputPng",
        resolve("screenshots/qa-window-icon.png"),
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
  assert.equal(windowIcon.ok, true);
  const extraIcons = [];
  for (const [name, file] of [
    ["terminal", join(windowIdentity.resources, "native-terminal/Helself.Terminal.exe")],
    ["shortcut", join(windowIdentity.resources, "helself.ico")],
    ...(process.argv[3] ? [["installer", resolve(process.argv[3])]] : []),
    ...(process.argv[4] ? [["online-installer", resolve(process.argv[4])]] : []),
  ]) {
    const icon = JSON.parse(
      execFileSync(
        "pwsh",
        [
          "-NoProfile",
          "-File",
          resolve("scripts/windows-icon-check.ps1"),
          "-IconPath",
          file,
          "-OutputPng",
          resolve(`screenshots/qa-${name}-icon.png`),
        ],
        { encoding: "utf8", windowsHide: true },
      ),
    );
    assert.equal(icon.ok, true, `${name} 必须使用 Helself 图标`);
    extraIcons.push({ name, ...icon });
  }
  assert.deepEqual(pageErrors, []);
  console.log(
    JSON.stringify({
      ok: true,
      isolated: true,
      colors,
      executableIcon,
      windowIcon,
      extraIcons,
      taskbar,
      pageErrors,
    }),
  );
} finally {
  await instance?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
