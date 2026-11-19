#!/usr/bin/env node
/**
 * Regenerate CHANGELOG.md from `src/lib/changelog.ts`.
 *
 * The TS file is the source of truth because the settings dialog renders from
 * it; this keeps the repo's own changelog from drifting out of step. Run it
 * after editing a release entry.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function parseReleases(source) {
  const file = ts.createSourceFile("changelog.ts", source, ts.ScriptTarget.Latest, true);
  if (file.parseDiagnostics.length)
    throw new Error(
      `Invalid RELEASES source: ${ts.flattenDiagnosticMessageText(file.parseDiagnostics[0].messageText, " ")}`,
    );
  const declarations = file.statements
    .filter(
      (statement) =>
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
        statement.declarationList.flags & ts.NodeFlags.Const,
    )
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "RELEASES",
    );
  const array = declarations[0]?.initializer;
  if (
    declarations.length !== 1 ||
    !array ||
    !ts.isArrayLiteralExpression(array) ||
    !array.elements.length
  )
    throw new Error("RELEASES must be one exported, non-empty const array literal");

  // Read literal nodes only: formatting and escaped delimiters must not change the release content.
  return array.elements.map((entry, index) => {
    const label = `RELEASES[${index}]`;
    if (!ts.isObjectLiteralExpression(entry)) throw new Error(`${label} must be an object literal`);
    const fields = new Map();
    for (const property of entry.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ||
        fields.has(property.name.text)
      )
        throw new Error(`${label} must contain unique literal properties`);
      fields.set(property.name.text, property.initializer);
    }
    const text = (value, name) => {
      if (!value || !ts.isStringLiteral(value) || !value.text.trim())
        throw new Error(`${label}.${name} must be a non-empty string literal`);
      return value.text;
    };
    const changes = fields.get("changes");
    if (!changes || !ts.isArrayLiteralExpression(changes) || !changes.elements.length)
      throw new Error(`${label}.changes must be a non-empty string array literal`);
    return {
      version: text(fields.get("version"), "version"),
      date: text(fields.get("date"), "date"),
      title: text(fields.get("title"), "title"),
      changes: changes.elements.map((change, changeIndex) =>
        text(change, `changes[${changeIndex}]`),
      ),
    };
  });
}

export function renderChangelog(releases) {
  const lines = [
    "# 更新日志",
    "",
    "> 本文件由 `node scripts/write-changelog.mjs` 从 `src/lib/changelog.ts` 生成，",
    "> 请改那个文件而不是这里 —— 应用内的「设置 → 更新日志」读的是同一份数据。",
    "",
  ];
  for (const release of releases) {
    lines.push(`## ${release.version} — ${release.title}`, "", `_${release.date}_`, "");
    for (const change of release.changes) lines.push(`- ${change}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function writeChangelog(directory = root) {
  const source = readFileSync(join(directory, "src/lib/changelog.ts"), "utf8");
  const releases = parseReleases(source);
  writeFileSync(join(directory, "CHANGELOG.md"), renderChangelog(releases), "utf8");
  return releases.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const count = writeChangelog();
  console.log(`CHANGELOG.md written (${count} release${count > 1 ? "s" : ""})`);
}
