import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { windowsAppId, migrateLegacyWindowsShortcut } from "./windows-identity.mjs";
import * as identity from "./windows-identity.mjs";
test("Windows 开发版与正式版使用不同应用身份", () => {
  assert.notEqual(windowsAppId(false), windowsAppId(true));
  assert.equal(windowsAppId(true), "dev.helself.app");
  assert.notEqual(windowsAppId(true), "dev.helself.nanpad", "不再复用旧任务栏分组缓存");
});

test("显式资料目录兼容两种参数形式，相对路径解析为绝对目录", () => {
  const path = join("profiles", "isolated test");
  for (const argv of [[`--user-data-dir=${path}`], ["--user-data-dir", path]])
    assert.equal(identity.explicitUserDataDirectory(argv), resolve(path));
  assert.equal(identity.explicitUserDataDirectory(["--user-data-directory=ignored"]), null);
});

test("所有自动系统集成共享显式参数与测试环境的隔离判定", () => {
  assert.equal(identity.isIsolatedLaunch({ argv: [] }), false);
  assert.equal(identity.isIsolatedLaunch({ argv: [], testDataDirectory: "test-profile" }), true);
  for (const argv of [["--user-data-dir=profile"], ["--user-data-dir", "profile"]])
    assert.equal(identity.isIsolatedLaunch({ argv }), true);
  assert.equal(identity.isIsolatedLaunch({ argv: ["--inspect=0"] }), false);
});

test("原生通知身份在任何支持探测前初始化，正常安装版继续探测", () => {
  const calls = [];
  const app = {
    isPackaged: true,
    setToastActivatorCLSID: (id) => calls.push(["identity", id]),
  };
  const notification = {
    isSupported: () => {
      calls.push(["probe"]);
      return true;
    },
  };
  const supported = identity.createNativeNotificationSupport(app, notification, {
    platform: "win32",
    argv: [],
  });
  assert.match(identity.WINDOWS_TOAST_CLSID, /^\{[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\}$/);
  assert.deepEqual(calls, [["identity", identity.WINDOWS_TOAST_CLSID]]);
  assert.equal(supported(), true);
  assert.deepEqual(calls, [["identity", identity.WINDOWS_TOAST_CLSID], ["probe"]]);
});

test("Windows 开发、便携和显式隔离资料不触发全局 Toast 注册", () => {
  const notification = {
    isSupported: () => {
      throw new Error("unexpected global probe");
    },
  };
  for (const options of [
    { packaged: false },
    { portable: true },
    { argv: ["--user-data-dir=D:\\qa-profile"] },
    { argv: ["--user-data-dir", "D:\\qa-profile"] },
    { testDataDirectory: "D:\\qa-profile" },
  ]) {
    const app = { isPackaged: options.packaged ?? true, setToastActivatorCLSID: () => {} };
    const supported = identity.createNativeNotificationSupport(app, notification, {
      platform: "win32",
      argv: [],
      ...options,
    });
    assert.equal(supported(), false);
  }
});

test("其他平台保持原生通知行为，且不会调用仅 Windows 的身份 API", () => {
  for (const platform of ["darwin", "linux"]) {
    let probes = 0;
    const supported = identity.createNativeNotificationSupport(
      { isPackaged: false },
      {
        isSupported: () => {
          probes++;
          return false;
        },
      },
      { platform, portable: true, argv: ["--user-data-dir=/tmp/qa"] },
    );
    assert.equal(supported(), false);
    assert.equal(probes, 1);
  }
});
test("只备份抢占Helself身份的 Electron 快捷方式，重复运行无副作用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nanpad-identity-"));
  const file = join(directory, "Electron.lnk");
  const options = {
    programsDirectory: directory,
    backupDirectory: join(directory, "backups"),
    readShortcut: () => ({
      target: "C:\\runtime\\electron.exe",
      appUserModelId: "dev.helself.nanpad",
    }),
  };
  try {
    await writeFile(file, "fixture-shortcut");
    const backup = await migrateLegacyWindowsShortcut(options);
    assert.equal(await readFile(backup, "utf8"), "fixture-shortcut");
    await assert.rejects(stat(file), { code: "ENOENT" });
    assert.equal(await migrateLegacyWindowsShortcut(options), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function appFixture(t, { packaged = true, customPaths = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "helself-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = customPaths
    ? { userData: join(root, "custom-profile"), sessionData: join(root, "custom-session") }
    : {};
  const overrides = { ...paths };
  let name = "Electron";
  return {
    root,
    paths,
    app: {
      isPackaged: packaged,
      getName: () => name,
      setName: (value) => {
        name = value;
      },
      getPath: (key) => overrides[key] ?? join(root, name),
      setPath: (key, value) => {
        assert.ok(statSync(value).isDirectory(), "Electron 路径覆盖前目录必须存在");
        overrides[key] = value;
      },
    },
  };
}

test("显示名更改为Helself后仍使用原 Nanpad 数据与会话目录", async (t) => {
  const { app, root } = await appFixture(t);
  identity.initializeAppIdentity(app, { platform: "win32" });
  assert.equal(app.getName(), "Helself");
  assert.equal(app.getPath("userData"), join(root, "Nanpad"));
  assert.equal(app.getPath("sessionData"), join(root, "Nanpad"));
});

test("品牌更名保留显式用户目录与独立会话目录，正式版忽略开发环境覆盖", async (t) => {
  const { app, root, paths } = await appFixture(t, { customPaths: true });
  const ignored = join(root, "untrusted-test-path");
  identity.initializeAppIdentity(app, { testDataDirectory: ignored });
  assert.equal(app.getPath("userData"), paths.userData);
  assert.equal(app.getPath("sessionData"), paths.sessionData);
  await assert.rejects(stat(ignored), { code: "ENOENT" });
});

test("开发测试的数据和会话都留在隔离目录，避免更名时写入真实资料", async (t) => {
  const { app, root } = await appFixture(t, { packaged: false });
  const isolated = join(root, "isolated-profile");
  identity.initializeAppIdentity(app, { testDataDirectory: isolated, platform: "win32" });
  assert.equal(app.getName(), "Helself");
  assert.equal(app.getPath("userData"), isolated);
  assert.equal(app.getPath("sessionData"), isolated);
  await assert.rejects(stat(join(root, "Nanpad")), { code: "ENOENT" });
});

test("两种显式参数真正覆盖资料和会话目录，初始化不读取默认路径", async (t) => {
  for (const split of [false, true]) {
    const { app, root } = await appFixture(t, { customPaths: true });
    const profile = join(root, "explicit profile");
    const path = relative(process.cwd(), profile);
    const argv = split ? ["--user-data-dir", path] : [`--user-data-dir=${path}`];
    const getPath = app.getPath;
    let defaultReads = 0;
    app.getPath = (key) => {
      defaultReads++;
      return getPath(key);
    };
    identity.initializeAppIdentity(app, { argv, platform: "win32" });
    assert.equal(defaultReads, 0);
    assert.equal(getPath("userData"), profile);
    assert.equal(getPath("sessionData"), profile);
    assert.ok(statSync(profile).isDirectory());
    await assert.rejects(stat(join(root, "Nanpad")), { code: "ENOENT" });
  }
});

test("非法资料参数在改名、读取默认路径或创建任何资料目录前失败", async (t) => {
  const { app, root } = await appFixture(t, { packaged: false });
  app.getPath = () => {
    throw new Error("default path must not be read");
  };
  const fallback = join(root, "must-not-create");
  for (const argv of [
    ["--user-data-dir"],
    ["--user-data-dir="],
    ["--user-data-dir", ""],
    ["--user-data-dir", "   "],
    ["--user-data-dir", "--inspect=0"],
    ["--user-data-dir=--inspect=0"],
    ["--user-data-dir=first", "--user-data-dir=second"],
  ]) {
    assert.throws(
      () => identity.initializeAppIdentity(app, { argv, testDataDirectory: fallback }),
      /--user-data-dir/,
    );
    assert.equal(app.getName(), "Electron");
    assert.throws(
      () => identity.isIsolatedLaunch({ argv, testDataDirectory: fallback }),
      /--user-data-dir/,
    );
  }
  await assert.rejects(stat(fallback), { code: "ENOENT" });
  await assert.rejects(stat(join(root, "Nanpad")), { code: "ENOENT" });
});

test("开发测试目录仍优先于显式参数，正式版仍忽略开发环境存储覆盖", async (t) => {
  const { app, root } = await appFixture(t, { packaged: false });
  const testing = join(root, "test override");
  const explicit = join(root, "explicit");
  identity.initializeAppIdentity(app, {
    argv: ["--user-data-dir", explicit],
    testDataDirectory: testing,
  });
  assert.equal(app.getPath("userData"), testing);
  assert.equal(app.getPath("sessionData"), testing);
  await assert.rejects(stat(explicit), { code: "ENOENT" });
});

test("显式参数覆盖便携目录且不探测便携标记，保持独立资料位置", async (t) => {
  const { app, root } = await appFixture(t);
  const explicit = join(root, "explicit");
  const portable = join(root, "portable");
  const argv = ["--user-data-dir", explicit];
  assert.equal(
    identity.portableDataDirectory({
      packaged: true,
      platform: "win32",
      argv,
      exists: () => {
        throw new Error("portable marker must not be read");
      },
    }),
    null,
  );
  const state = identity.initializeAppIdentity(app, { argv, portableDirectory: portable });
  assert.equal(state.portable, false);
  assert.equal(app.getPath("userData"), explicit);
  assert.equal(app.getPath("sessionData"), explicit);
  await assert.rejects(stat(portable), { code: "ENOENT" });
});

for (const platform of ["darwin", "linux"]) {
  test(`${platform} 保留原应用名称与系统密钥存储身份`, async (t) => {
    const { app, root } = await appFixture(t);
    identity.initializeAppIdentity(app, { platform });
    assert.equal(app.getName(), "Nanpad");
    assert.equal(app.getPath("userData"), join(root, "Nanpad"));
    assert.equal(app.getPath("sessionData"), join(root, "Nanpad"));
  });
}
test("其他应用、独立开发身份与正式版快捷方式保持原样", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nanpad-identity-"));
  const file = join(directory, "Electron.lnk");
  try {
    await writeFile(file, "keep");
    for (const entry of [
      { target: "C:\\electron.exe", appUserModelId: "other.app" },
      { target: "C:\\electron.exe", appUserModelId: windowsAppId(false) },
      { target: "C:\\Nanpad.exe", appUserModelId: windowsAppId(true) },
    ]) {
      assert.equal(
        await migrateLegacyWindowsShortcut({
          programsDirectory: directory,
          backupDirectory: join(directory, "backups"),
          readShortcut: () => entry,
        }),
        null,
      );
      assert.equal(await readFile(file, "utf8"), "keep");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("便携标记只在 Windows 正式程序旁生效，显式用户目录优先", () => {
  const execPath = String.raw`D:\Tools\Helself\Helself.exe`;
  const marker = String.raw`D:\Tools\Helself\portable.txt`;
  const exists = (path) => path === marker;
  const base = { packaged: true, platform: "win32", execPath, argv: [execPath], exists };
  assert.equal(identity.PORTABLE_MARKER, "portable.txt");
  assert.equal(identity.portableDataDirectory(base), String.raw`D:\Tools\Helself\data`);
  assert.equal(identity.portableDataDirectory({ ...base, exists: () => false }), null);
  assert.equal(identity.portableDataDirectory({ ...base, packaged: false }), null);
  assert.equal(identity.portableDataDirectory({ ...base, platform: "darwin" }), null);
  assert.equal(
    identity.portableDataDirectory({ ...base, argv: [execPath, String.raw`--user-data-dir=E:\p`] }),
    null,
  );
});

test("便携模式的资料与会话都写入程序旁目录", async (t) => {
  const { app, root } = await appFixture(t);
  const portable = join(root, "Helself", "data");
  const result = identity.initializeAppIdentity(app, {
    portableDirectory: portable,
    platform: "win32",
  });
  assert.deepEqual(result, { portable: true });
  assert.equal(app.getPath("userData"), portable);
  assert.equal(app.getPath("sessionData"), portable);
  await assert.rejects(stat(join(root, "Nanpad")), { code: "ENOENT" });
});

test("开发版忽略便携目录，安装版返回非便携状态", async (t) => {
  const { app, root } = await appFixture(t, { packaged: false });
  const result = identity.initializeAppIdentity(app, {
    portableDirectory: join(root, "data"),
    platform: "win32",
  });
  assert.deepEqual(result, { portable: false });
  assert.equal(app.getPath("userData"), join(root, "Nanpad"));
});
