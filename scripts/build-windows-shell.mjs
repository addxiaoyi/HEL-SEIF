import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { WINDOWS_TOAST_CLSID, windowsAppId } from "../electron/services/windows-identity.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildWindowsShell({ test = false, root = workspace } = {}) {
  if (process.platform !== "win32") return null;
  if (!/^\{[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\}$/.test(WINDOWS_TOAST_CLSID))
    throw new Error("Windows toast identity is not a canonical CLSID");
  const outputDirectory = join(root, "release/windows-shell");
  await mkdir(outputDirectory, { recursive: true });
  const identity = join(outputDirectory, "ShellIdentity.g.cs");
  await writeFile(
    identity,
    `namespace Helself.WindowsShell { internal static class ShellIdentity { public const string AppId = ${JSON.stringify(windowsAppId(true))}; public const string ToastActivatorClsid = ${JSON.stringify(WINDOWS_TOAST_CLSID)}; } }\n`,
    "utf8",
  );
  const compiler = join(
    process.env.WINDIR || "C:/Windows",
    "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  );
  const source = join(root, "build/windows-shell/Shortcut.cs");
  const output = join(outputDirectory, "Helself.WindowsShell.exe");
  const common = ["/nologo", "/platform:x64", "/optimize+", "/utf8output", "/target:exe"];
  const run = (command, args) => {
    const child = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
    if (child.error) throw new Error(`Windows shortcut helper failed: ${child.error.message}`);
    if (child.status !== 0)
      throw new Error(
        `Windows shortcut helper failed: ${command} exited ${child.status ?? "without a status"}`,
      );
  };
  run(compiler, [
    ...common,
    `/out:${output}`,
    `/win32icon:${join(root, "build/icon.ico")}`,
    "/main:Helself.WindowsShell.ShortcutProgram",
    source,
    identity,
  ]);
  if (test) {
    const suite = join(outputDirectory, "windows-shell-tests.exe");
    run(compiler, [
      ...common,
      `/out:${suite}`,
      "/main:Helself.WindowsShell.ShortcutTests",
      "/reference:System.Web.Extensions.dll",
      source,
      identity,
      join(root, "build/windows-shell/Tests.cs"),
    ]);
    run(suite, []);
  }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = await buildWindowsShell({ test: process.argv.includes("--test") });
  console.log(
    output
      ? `Windows shortcut helper built: ${output}`
      : "Windows shortcut helper skipped on this platform",
  );
}
