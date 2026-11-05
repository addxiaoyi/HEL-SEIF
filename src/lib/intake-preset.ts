import { intakePreset, type IntakeEntry } from "./messy-intake.ts";
import { parsePaste } from "./parse-paste.ts";

/** 原文补齐凭据；审阅过的字段优先，避免录入时把用户的修正改回去。 */
export function intakeFormPreset(entry: IntakeEntry): Record<string, string> {
  if (entry.kind === "phone") return intakePreset(entry);
  const match = parsePaste(entry.line, entry.kind)[0];
  const preset = { ...match?.fields, ...intakePreset(entry) };
  // API Key、Token 和私钥仍用凭据识别器确认的子类型，不能降级成网站账号。
  if (entry.kind === "secret" && match?.fields.kind) preset.kind = match.fields.kind;
  return preset;
}
