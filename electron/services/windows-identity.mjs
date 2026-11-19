import { mkdir, rename, stat } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, win32 } from "node:path";

export const WINDOWS_TOAST_CLSID = "{3CB4C0F5-23A6-4BB7-8DB7-49E01A98A844}";

export function windowsAppId(packaged) {
  return packaged ? "dev.helself.app" : "dev.helself.app.development";
}

export function explicitUserDataDirectory(argv = process.argv) {
  let directory = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg !== "--user-data-dir" && !arg.startsWith("--user-data-dir=")) continue;
    if (directory !== null) throw new Error("--user-data-dir must be supplied only once");
    const value = arg === "--user-data-dir" ? argv[++index] : arg.slice("--user-data-dir=".length);
    if (typeof value !== "string" || !value.trim() || value.startsWith("-"))
      throw new Error("--user-data-dir requires a non-empty directory path, not another switch");
    directory = resolve(value);
  }
  return directory;
}

export function isIsolatedLaunch({ argv = process.argv, testDataDirectory } = {}) {
  const explicit = explicitUserDataDirectory(argv);
  return Boolean(explicit || testDataDirectory);
}

export function createNativeNotificationSupport(
  app,
  notification,
  { platform = process.platform, portable = false, argv = process.argv, testDataDirectory } = {},
) {
  if (platform === "win32") app.setToastActivatorCLSID(WINDOWS_TOAST_CLSID);
  const isolated = isIsolatedLaunch({ argv, testDataDirectory });
  // Electron 44's support probe registers a global shortcut, even without showing a toast.
  const allowed = platform !== "win32" || (app.isPackaged && !portable && !isolated);
  return () => allowed && notification.isSupported();
}

/** 程序目录中存在此文件时以便携模式运行，资料保存在同目录的 data 文件夹。 */
export const PORTABLE_MARKER = "portable.txt";

/** 便携版只认 Windows 正式程序旁的标记文件；显式指定的用户目录始终优先。 */
export function portableDataDirectory({
  packaged,
  platform = process.platform,
  execPath = process.execPath,
  argv = process.argv,
  exists = existsSync,
} = {}) {
  if (isIsolatedLaunch({ argv }) || !packaged || platform !== "win32") return null;
  const root = win32.dirname(execPath);
  return exists(win32.join(root, PORTABLE_MARKER)) ? win32.join(root, "data") : null;
}

/** 便携目录不可写时不能悄悄退回系统目录，否则资料位置与用户预期不一致。 */
function assertWritable(directory) {
  mkdirSync(directory, { recursive: true });
  const probe = join(directory, `.write-test-${process.pid}`);
  writeFileSync(probe, "");
  rmSync(probe, { force: true });
}

/** 显示身份独立于安装与存储身份；改名不能迁移用户资料或 Chromium 会话。 */
export function initializeAppIdentity(
  app,
  { testDataDirectory, portableDirectory, platform = process.platform, argv = process.argv } = {},
) {
  // Chromium does not consume the split switch value, so both forms must set paths explicitly.
  const explicit = explicitUserDataDirectory(argv);
  app.setName("Nanpad");
  const isolated = !app.isPackaged && testDataDirectory ? resolve(testDataDirectory) : null;
  const portable = !isolated && !explicit && app.isPackaged && portableDirectory;
  if (portable) assertWritable(portable);
  const userData = isolated || explicit || portable || app.getPath("userData");
  const sessionData = isolated || explicit || portable || app.getPath("sessionData");
  for (const directory of new Set([userData, sessionData]))
    mkdirSync(directory, { recursive: true });
  // macOS/Linux 的系统密钥存储依赖原应用名，Windows Shell 改名仅作用于 Windows。
  if (platform === "win32") app.setName("Helself");
  app.setPath("userData", userData);
  app.setPath("sessionData", sessionData);
  return { portable: Boolean(portable) };
}

/** 只迁移抢占正式版身份的 Electron 开发快捷方式，并保留可恢复备份。 */
export async function migrateLegacyWindowsShortcut({
  programsDirectory,
  backupDirectory,
  readShortcut,
}) {
  const source = join(programsDirectory, "Electron.lnk");
  try {
    await stat(source);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const entry = readShortcut(source);
  if (
    entry.appUserModelId !== "dev.helself.nanpad" ||
    win32.basename(entry.target).toLowerCase() !== "electron.exe"
  )
    return null;
  await mkdir(backupDirectory, { recursive: true });
  const destination = join(backupDirectory, `Electron-${Date.now()}-${crypto.randomUUID()}.lnk`);
  await rename(source, destination);
  return destination;
}
