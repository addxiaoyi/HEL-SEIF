import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { demoSnapshot } from "../electron/services/demo.mjs";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

// 独立浏览器上下文只加载示例资料，不连接桌面桥接、私人账号或本机日志。
const origin = new URL(checkedUrl(process.env.NANPAD_QA_URL ?? "http://127.0.0.1:8080/")).origin;
const browser = await chromium.launch();
const passwordsOnly = process.argv.includes("--passwords-only");
const outputDirectory = process.env.NANPAD_SITE_CAPTURE_DIR ?? "site";
const output = (name) =>
  checkedOutputPath(join(outputDirectory, `${name}.png`), [
    resolve("site"),
    resolve("screenshots"),
    resolve("release"),
  ]);
output("passwords");
await mkdir(outputDirectory, { recursive: true });
const errors = [];
const consoleErrors = [];
const modules = {};
let page;
try {
  const context = await browser.newContext({
    viewport: { width: 1480, height: 940 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce",
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.fulfill({ status: 204, body: "" }),
  );
  await context.addInitScript((snapshot) => {
    localStorage.setItem("sinan-assets-v1", JSON.stringify({ state: snapshot, version: 0 }));
    localStorage.setItem(
      "sinan-settings-v1",
      JSON.stringify({ state: { theme: "light", locale: "zh", assetLayout: "cards" }, version: 0 }),
    );
  }, demoSnapshot());
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  // 跟随 Vite 的实际模块地址，避免 HMR 时间戳产生第二份状态实例。
  page.on("request", (request) => {
    const url = new URL(request.url());
    const name = /^\/src\/lib\/(profile|store|documents|vault-state|settings)\.ts$/.exec(
      url.pathname,
    )?.[1];
    if (name) modules[name] = request.url();
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.evaluate(async (paths) => {
    window.__siteModules = paths;
    const { useProfile } = await import(paths.profile);
    useProfile.setState({ profile: { name: "Helself演示空间", ready: true, vaultExists: false } });
  }, modules);
  await page.getByText("Helself演示空间", { exact: true }).waitFor();
  if (!passwordsOnly) {
    await page.screenshot({ path: output("overview"), animations: "disabled" });
    await page.evaluate(async () => {
      const { useDocuments } = await import(window.__siteModules.documents);
      const { useAppStore } = await import(window.__siteModules.store);
      const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
      const heading = (text) => ({
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text }],
      });
      for (const title of ["账号与订阅整理", "域名续费记录", "项目资料索引"]) {
        await useDocuments.getState().create([], {
          title,
          content: { type: "doc", content: [paragraph("示例资料，用于展示文档整理与阅读界面。")] },
        });
      }
      await useDocuments.getState().create([{ kind: "server", id: "demo-server-0" }], {
        title: "星桥项目 · 部署与维护手册",
        content: {
          type: "doc",
          content: [
            paragraph(
              "一份连起主机、域名与日常维护的项目笔记。本文使用演示资产，不包含真实连接信息。",
            ),
            heading("工作空间概览"),
            paragraph(
              "香港节点承载应用服务，新加坡节点负责数据库与缓存。相关资产与说明保存在同一工作空间，需要时可直接回到资产记录。",
            ),
            heading("每周维护清单"),
            {
              type: "bulletList",
              content: [
                "核对域名与证书的到期提醒。",
                "检查备份是否完成，并记录恢复演练结果。",
                "查看资源与用量趋势，更新本周的维护记录。",
              ].map((text) => ({ type: "listItem", content: [paragraph(text)] })),
            },
            heading("账号与使用说明"),
            paragraph(
              "密码保存在独立的加密凭据中，文档记录用途与操作步骤。将账号关联到说明，下次使用时就能一起找到。",
            ),
            { type: "blockquote", content: [paragraph("让记录留在资产旁，让下一次查找更轻松。")] },
          ],
        },
      });
      useAppStore.getState().setView("docs");
    });
    await page.getByRole("button", { name: "编辑文档", exact: true }).waitFor();
    await page.screenshot({ path: output("documents"), animations: "disabled" });
    await page.evaluate(async () => {
      const records = Array.from({ length: 7 }, (_, index) => {
        const date = new Date();
        date.setHours(12, 0, 0, 0);
        date.setDate(date.getDate() - 6 + index);
        return ["文档整理 · 示例", "编程助手 · 示例"].map((name, sourceIndex) => ({
          kind: "tokens",
          sourceId: `demo-api-${sourceIndex}`,
          sourceName: name,
          key: `demo-${index}-${sourceIndex}`,
          label: "示例 API 用量",
          model: "示例模型",
          bucketStart: date.toISOString(),
          checkedAt: date.toISOString(),
          input: [12000, 18000, 9000, 27000, 21000, 33000, 24000][index] * (sourceIndex + 1),
          output: [2300, 3100, 1800, 4800, 3400, 5200, 4100][index],
          cached: 1200 * (index + 1),
        }));
      }).flat();
      window.sinan = {
        win: {
          state: async () => ({ platform: "win32", maximized: false }),
          onMaximized: () => () => {},
        },
        usage: { list: async () => ({ sources: [], records }), localStatus: async () => null },
      };
      const { useAppStore } = await import(window.__siteModules.store);
      useAppStore.getState().setView("usage");
    });
    await page.getByRole("region", { name: "用量图表", exact: true }).waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll(".recharts-bar-rectangle path").length > 0,
    );
    await page.getByRole("region", { name: "用量图表", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: output("usage"), animations: "disabled" });

    // 续费日历：月视图与右侧当日事项，日期来自演示资产的到期 / 续费日。
    await page.evaluate(async () => {
      const { useAppStore } = await import(window.__siteModules.store);
      useAppStore.getState().setView("renewals");
    });
    await page.getByRole("region", { name: "续费日历", exact: true }).waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: output("renewals"), animations: "disabled" });

    // 服务器表格：同一份演示资产换成表格布局。
    await page.evaluate(async () => {
      const { useSettings } = await import(window.__siteModules.settings);
      const { useAppStore } = await import(window.__siteModules.store);
      useSettings.getState().setAssetLayout("table");
      useAppStore.getState().setView("servers");
    });
    await page.getByRole("region", { name: "资产表格", exact: true }).waitFor();
    await page.getByRole("columnheader", { name: /主机/ }).waitFor();
    await page.screenshot({ path: output("table"), animations: "disabled" });

    // 新建资产窗口的订阅模板：滚动到「从常用订阅开始」。
    await page.evaluate(async () => {
      const { useAppStore } = await import(window.__siteModules.store);
      useAppStore.getState().setCreatePickerOpen(true);
    });
    const picker = page.getByRole("dialog", { name: "选择资产类型", exact: true });
    await picker.waitFor();
    await picker.getByText("从常用订阅开始", { exact: true }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: output("onboarding"), animations: "disabled" });
    await page.evaluate(async () => {
      const { useAppStore } = await import(window.__siteModules.store);
      useAppStore.getState().setCreatePickerOpen(false);
    });

    // 主机详情：监控概览、关联资产与凭据位置。
    await page.evaluate(async () => {
      const now = Date.now();
      const samples = Array.from({ length: 97 }, (_, index) => ({
        at: new Date(now - (96 - index) * 15 * 60_000).toISOString(),
        cpu: Math.max(4, 38 + Math.sin(index / 6) * 9),
        memory: Math.max(6, 62 + Math.sin(index / 9) * 5),
        disk: 46,
      }));
      window.sinan = {
        ...window.sinan,
        win: {
          state: async () => ({ platform: "win32", maximized: false }),
          onMaximized: () => () => {},
        },
        metrics: {
          list: async () => samples,
          onUpdated: () => () => {},
          onError: () => () => {},
        },
      };
      const { useSettings } = await import(window.__siteModules.settings);
      const { useAppStore } = await import(window.__siteModules.store);
      useSettings.getState().setAssetLayout("cards");
      useAppStore.getState().setExpanded({
        kind: "server",
        id: "demo-server-0",
        origin: { x: 0, y: 0, w: 0, h: 0 },
      });
    });
    await page.getByRole("button", { name: "监控概览", exact: true }).waitFor();
    await page.screenshot({ path: output("detail"), animations: "disabled" });

    // 端口与容器：给演示主机补一份只读采集结果和两个绑定服务，全部为合成数据。
    await page.evaluate(async () => {
      const { useAppStore } = await import(window.__siteModules.store);
      const state = useAppStore.getState();
      const server = state.servers.find((item) => item.id === "demo-server-0");
      const collectedAt = new Date().toISOString();
      state.upsertServer({
        ...server,
        serviceScan: {
          collectedAt,
          ports: [
            { proto: "tcp", port: 22, scope: "local", address: "0.0.0.0", process: "sshd", pid: 812 },
            { proto: "tcp", port: 80, scope: "public", address: "0.0.0.0", process: "caddy", pid: 1042 },
            { proto: "tcp", port: 443, scope: "public", address: "0.0.0.0", process: "caddy", pid: 1042 },
            { proto: "tcp", port: 3000, scope: "local", address: "127.0.0.1", process: "node", pid: 2210 },
            { proto: "tcp", port: 5432, scope: "private", address: "10.0.0.12", process: "postgres", pid: 1530 },
            { proto: "tcp", port: 6379, scope: "private", address: "10.0.0.12", process: "redis-server", pid: 1544 },
          ],
          docker: {
            available: true,
            containers: [
              {
                id: "demo-container-api",
                name: "starbridge-api",
                image: "ghcr.io/starbridge/api:2026.10",
                state: "running",
                status: "Up 6 days (healthy)",
                health: "healthy",
                restartCount: 0,
                startedAt: collectedAt,
                cpu: 12.4,
                memoryPct: 38,
                memoryUsage: "612MiB / 1.6GiB",
                ports: [{ containerPort: 3000, proto: "tcp", hostPort: 3000, hostIp: "127.0.0.1" }],
              },
              {
                id: "demo-container-web",
                name: "starbridge-web",
                image: "ghcr.io/starbridge/web:2026.10",
                state: "running",
                status: "Up 6 days (healthy)",
                health: "healthy",
                restartCount: 0,
                startedAt: collectedAt,
                cpu: 3.1,
                memoryPct: 14,
                memoryUsage: "210MiB / 1.5GiB",
                ports: [{ containerPort: 80, proto: "tcp", hostPort: 8080, hostIp: "0.0.0.0" }],
              },
              {
                id: "demo-container-worker",
                name: "starbridge-worker",
                image: "ghcr.io/starbridge/worker:2026.10",
                state: "exited",
                status: "Exited (137) 2 hours ago",
                restartCount: 3,
                exitCode: 137,
                oomKilled: true,
                startedAt: collectedAt,
                ports: [],
              },
            ],
          },
        },
      });
      const base = { status: "online", notes: "演示服务，不连接真实基础设施。", tags: ["演示", "星桥商城"] };
      state.upsertService({
        ...base,
        id: "demo-service-api",
        name: "星桥商城 API",
        category: "custom",
        url: "https://api.starbridge.example",
        provider: "自建",
        endpoint: {
          serverId: "demo-server-0",
          port: 3000,
          proto: "tcp",
          container: "starbridge-api",
          domainId: "demo-domain-1",
        },
      });
      state.upsertService({
        ...base,
        id: "demo-service-web",
        name: "星桥商城前台",
        category: "custom",
        url: "https://starbridge.example",
        provider: "自建",
        endpoint: {
          serverId: "demo-server-0",
          port: 80,
          proto: "tcp",
          container: "starbridge-web",
          domainId: "demo-domain-0",
        },
      });
    });
    await page.getByRole("button", { name: /端口与容器/ }).click();
    await page.getByRole("heading", { name: "端口与容器", exact: true }).waitFor();
    await page.screenshot({ path: output("services"), animations: "disabled" });

    // 密钥库分组：只把界面切到已解锁状态，不读写任何真实凭据。
    await page.evaluate(async () => {
      window.sinan = {
        ...window.sinan,
        win: {
          state: async () => ({ platform: "win32", maximized: false }),
          onMaximized: () => () => {},
        },
        vault: { status: async () => ({ exists: true, unlocked: true }) },
        onVaultChanged: () => () => {},
      };
      const { useVault } = await import(window.__siteModules["vault-state"]);
      useVault.setState({ checked: true, exists: true, unlocked: true });
      const { useAppStore } = await import(window.__siteModules.store);
      useAppStore.getState().setExpanded(null);
      useAppStore.getState().setView("vault");
    });
    await page.getByRole("region", { name: "密钥分组", exact: true }).waitFor();
    await page.screenshot({ path: output("vault"), animations: "disabled" });

    // 深色主题的总览。
    await page.evaluate(async () => {
      const { useSettings } = await import(window.__siteModules.settings);
      const { useAppStore } = await import(window.__siteModules.store);
      useSettings.getState().setTheme("dark");
      useAppStore.getState().setView("overview");
    });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.getByText("Helself演示空间", { exact: true }).waitFor();
    await page.screenshot({ path: output("overview-dark"), animations: "disabled" });
    await page.evaluate(async () => {
      const { useSettings } = await import(window.__siteModules.settings);
      useSettings.getState().setTheme("light");
    });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  }
  await page.evaluate(async () => {
    // 仅模拟系统文件选择后的无密码预览，实际界面仍由应用组件渲染。
    // 不在网页中创建、读取或写入真实凭据，也不调用本机桌面服务。
    window.sinan = {
      ...window.sinan,
      win: {
        state: async () => ({ platform: "win32", maximized: false }),
        onMaximized: () => () => {},
      },
      vault: { status: async () => ({ exists: true, unlocked: true }) },
      onVaultChanged: () => () => {},
      passwords: {
        previewImport: async () => ({
          ticket: "synthetic-site-preview",
          total: 6,
          added: 3,
          duplicates: 2,
          conflicts: 1,
          invalid: 0,
          rows: [
            {
              title: "星桥 · 个人账号",
              url: "https://starbridge.example",
              username: "personal@example.test",
              status: "new",
            },
            {
              title: "星桥 · 工作账号",
              url: "https://starbridge.example",
              username: "work@example.test",
              status: "new",
            },
            {
              title: "云端笔记",
              url: "https://notes.example.test",
              username: "reader@example.test",
              status: "new",
            },
            {
              title: "项目协作",
              url: "https://team.example.test",
              username: "owner@example.test",
              status: "duplicate",
            },
            {
              title: "设计资料",
              url: "https://design.example.test",
              username: "designer@example.test",
              status: "duplicate",
            },
            {
              title: "研发平台",
              url: "https://dev.example.test",
              username: "developer@example.test",
              status: "conflict",
            },
          ],
        }),
        cancelImport: async () => {},
      },
    };
    const { useAppStore } = await import(window.__siteModules.store);
    useAppStore.getState().setView("vault");
  });
  await page.getByRole("button", { name: "浏览器密码", exact: true }).click();
  const transfer = page.getByRole("dialog", { name: "浏览器密码", exact: true });
  await transfer.getByRole("button", { name: "选择 CSV 文件", exact: true }).click();
  await transfer.getByRole("button", { name: "导入 3 个账号", exact: true }).waitFor();
  assert.equal(await transfer.getByRole("row").count(), 7);
  assert.equal(await transfer.locator('input[type="password"]').count(), 0);
  await page.screenshot({ path: output("passwords"), animations: "disabled" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      screenshots: passwordsOnly
        ? ["passwords"]
        : [
            "overview",
            "documents",
            "usage",
            "renewals",
            "table",
            "onboarding",
            "detail",
            "services",
            "vault",
            "overview-dark",
            "passwords",
          ],
      synthetic: true,
      privateData: false,
      pageErrors: errors,
      consoleErrors,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({ pageErrors: errors, visibleText: await page?.locator("body").innerText() }),
  );
  await page?.screenshot({ path: "screenshots/site-capture-failure.png" });
  throw error;
} finally {
  await browser.close();
}
