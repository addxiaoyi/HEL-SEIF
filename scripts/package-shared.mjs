import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import { mainProcessFiles } from "./package-stage.mjs";

// 整理逻辑同时被 UI 与主进程引用；安装包需要编译后的模块，不能依赖开发源码目录。
export async function stageSharedRuntime(root, stage) {
  const copied = [];
  for (const file of mainProcessFiles(root)) {
    const path = relative(root, file).replaceAll("\\", "/");
    if (path.startsWith("../") || isAbsolute(path)) throw new Error("桌面依赖不能越过项目目录。");
    const typed = path.endsWith(".ts");
    if (!path.startsWith("electron/") && !typed) throw new Error(`尚未声明的桌面共享模块：${path}`);
    const source = await readFile(file, "utf8");
    let compiled = source;
    if (typed) {
      const output = ts.transpileModule(source, {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          rewriteRelativeImportExtensions: true,
        },
      });
      const errors =
        output.diagnostics?.filter((entry) => entry.category === ts.DiagnosticCategory.Error) ?? [];
      if (errors.length)
        throw new Error(
          `${path}: ${errors.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, " ")).join("; ")}`,
        );
      compiled = output.outputText;
    }
    // 主进程保持 ESM 文件布局；仅把明确的相对 TypeScript 引用改成编译后的扩展名。
    compiled = compiled.replace(
      /(from\s*|import\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2/g,
      "$1$2$3.js$2",
    );
    const target = resolve(stage, path.replace(/\.ts$/, ".js"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, compiled);
    if (typed) copied.push(path);
  }
  return copied;
}
