import assert from "node:assert/strict";
import { test } from "node:test";
import { useIntakeSession } from "./intake-session.ts";
import {
  editField,
  mergeEntries,
  parseMessyText,
  refreshSaved,
  setEntryIgnored,
} from "./messy-intake.ts";
import type { Snapshot } from "./types.ts";

function startSession(): void {
  const bundle = parseMessyText("example.com 到期 2026-08-12\na.example.com 到期 2026-09-01");
  useIntakeSession.setState({
    text: "",
    result: { bundle, mode: "local", model: "", error: "", redacted: 0 },
    filterKind: "all",
    onlyProblems: false,
    history: [],
    historyActionIds: [],
    lastActionId: null,
    pendingRun: null,
    runError: "",
  });
}

test("改一条再撤销，恢复原样且历史归零", () => {
  startSession();
  const before = useIntakeSession.getState().result!.bundle;
  useIntakeSession.getState().updateBundle((bundle) => setEntryIgnored(bundle, 0, true));
  assert.equal(useIntakeSession.getState().result!.bundle.entries[0].ignored, true);
  assert.equal(useIntakeSession.getState().history.length, 1);

  useIntakeSession.getState().undo();
  assert.equal(useIntakeSession.getState().result!.bundle, before);
  assert.ok(!useIntakeSession.getState().result!.bundle.entries[0].ignored);
  assert.equal(useIntakeSession.getState().history.length, 0);
});

test("自动刷新不记历史，撤销不会把刷新退回去", () => {
  startSession();
  useIntakeSession.getState().updateBundle((bundle) => ({ ...bundle }), false);
  assert.equal(useIntakeSession.getState().history.length, 0);

  useIntakeSession.getState().undo();
  assert.equal(useIntakeSession.getState().result!.bundle.entries.length, 2);
});

test("历史最多留 20 步，更早的改动撤不回来", () => {
  startSession();
  for (let step = 0; step < 25; step += 1) {
    useIntakeSession.getState().updateBundle((bundle) => ({ ...bundle }));
  }
  assert.equal(useIntakeSession.getState().history.length, 20);

  for (let step = 0; step < 20; step += 1) useIntakeSession.getState().undo();
  assert.equal(useIntakeSession.getState().history.length, 0);
});

test("没有结果时改不动也撤不动", () => {
  useIntakeSession.getState().setResult(null);
  useIntakeSession.getState().updateBundle((bundle) => ({ ...bundle }));
  useIntakeSession.getState().undo();
  assert.equal(useIntakeSession.getState().result, null);
  assert.equal(useIntakeSession.getState().history.length, 0);
});

test("资料保存后再撤销，恢复内容但保留最新的已有资料对照", () => {
  startSession();
  useIntakeSession.getState().updateBundle((bundle) => setEntryIgnored(bundle, 0, true));
  const snapshot = { domains: [{ id: "saved-domain", name: "example.com" }] } as Partial<Snapshot>;
  useIntakeSession.getState().updateBundle((bundle) => refreshSaved(bundle, snapshot), false);
  useIntakeSession.getState().undo();
  const entry = useIntakeSession.getState().result!.bundle.entries[0];
  assert.ok(!entry.ignored);
  assert.equal(entry.saved?.id, "saved-domain");
  assert.equal(entry.questions.filter((question) => question.startsWith("资料里已经有")).length, 1);
});

test("自动刷新即使没有改变当前结果，也刷新撤销历史中的已有资产", () => {
  startSession();
  useIntakeSession
    .getState()
    .updateBundle((bundle) => editField(bundle, 0, "name", "changed.com")!);
  const snapshot = {
    domains: [{ id: "saved-original", name: "example.com" }],
  } as Partial<Snapshot>;
  const current = useIntakeSession.getState().result!.bundle;
  useIntakeSession.getState().updateBundle((bundle) => refreshSaved(bundle, snapshot), false);
  assert.equal(useIntakeSession.getState().result!.bundle, current);
  useIntakeSession.getState().undo();
  assert.equal(useIntakeSession.getState().result!.bundle.entries[0].saved?.id, "saved-original");
});

test("已有资产改名后对照说明随之更新", () => {
  const snapshot = {
    servers: [{ id: "server", name: "旧名称", host: "203.0.113.7" }],
  } as Partial<Snapshot>;
  const bundle = parseMessyText("203.0.113.7 root 到期 2027-01-01", snapshot);
  const renamed = refreshSaved(bundle, { servers: [{ ...snapshot.servers![0], name: "新名称" }] });
  assert.equal(renamed.entries[0].saved?.name, "新名称");
  assert.match(renamed.entries[0].questions.join(" "), /新名称/);
  assert.doesNotMatch(renamed.entries[0].questions.join(" "), /旧名称/);
});

test("合并通知在自动刷新后仍可撤销，并保留最新资料对照", () => {
  startSession();
  useIntakeSession.getState().updateBundle((bundle) => mergeEntries(bundle, 0, 1));
  const actionId = useIntakeSession.getState().lastActionId!;
  useIntakeSession.getState().updateBundle(
    (bundle) =>
      refreshSaved(bundle, {
        domains: [{ id: "saved", name: "example.com" }],
      } as Partial<Snapshot>),
    false,
  );
  useIntakeSession.getState().undo(actionId);
  assert.equal(useIntakeSession.getState().result!.bundle.entries.length, 2);
  assert.equal(useIntakeSession.getState().result!.bundle.entries[0].saved?.id, "saved");
});

test("过期合并通知不能撤销后续编辑，即使历史深度相同", () => {
  startSession();
  useIntakeSession.getState().updateBundle((bundle) => mergeEntries(bundle, 0, 1));
  const actionId = useIntakeSession.getState().lastActionId!;
  useIntakeSession.getState().undo();
  useIntakeSession
    .getState()
    .updateBundle((bundle) => editField(bundle, 0, "name", "changed.com")!);
  useIntakeSession.getState().undo(actionId);
  assert.equal(useIntakeSession.getState().result!.bundle.entries[0].title, "changed.com");
  assert.equal(useIntakeSession.getState().history.length, 1);
});

test("重新整理清空历史，旧通知不能撤销新会话的改动", () => {
  startSession();
  useIntakeSession.getState().updateBundle((bundle) => mergeEntries(bundle, 0, 1));
  const actionId = useIntakeSession.getState().lastActionId!;
  const bundle = parseMessyText("fresh.example.com");
  useIntakeSession
    .getState()
    .setResult({ bundle, mode: "local", model: "", error: "", redacted: 0 });
  assert.equal(useIntakeSession.getState().history.length, 0);
  useIntakeSession.getState().updateBundle((current) => setEntryIgnored(current, 0, true));
  useIntakeSession.getState().undo(actionId);
  assert.equal(useIntakeSession.getState().result!.bundle.entries[0].ignored, true);
});

test("没有实际改动不占用撤销历史", () => {
  startSession();
  const before = useIntakeSession.getState();
  before.updateBundle((bundle) => editField(bundle, 0, "name", "example.com")!);
  assert.equal(useIntakeSession.getState(), before);
});

test("进行中的整理跨面板共享，重复点击不会再发起一轮", () => {
  startSession();
  const session = useIntakeSession.getState();
  const id = session.startRun()!;
  assert.equal(useIntakeSession.getState().pendingRun, id);
  assert.equal(session.startRun(), null);
  assert.equal(session.endRun(id), true);
  assert.equal(useIntakeSession.getState().pendingRun, null);
});

test("当前整理完成后接收结果，并重置筛选和撤销历史", () => {
  startSession();
  const session = useIntakeSession.getState();
  session.updateBundle((bundle) => setEntryIgnored(bundle, 0, true));
  session.setFilterKind("domain");
  session.setOnlyProblems(true);
  const id = session.startRun()!;
  const parsed = { ...useIntakeSession.getState().result!, model: "finished-model" };
  assert.equal(session.finishRun(id, parsed), true);
  const current = useIntakeSession.getState();
  assert.equal(current.result, parsed);
  assert.equal(current.pendingRun, null);
  assert.equal(current.filterKind, "all");
  assert.equal(current.onlyProblems, false);
  assert.equal(current.history.length, 0);
});

test("输入新原文后，迟到的整理结果不能覆盖当前草稿", async () => {
  startSession();
  const session = useIntakeSession.getState();
  const before = session.result!;
  const id = session.startRun()!;
  const response = Promise.resolve({ ...before, model: "outdated-model" });
  session.setText("new.example.com");
  assert.equal(session.finishRun(id, await response), false);
  assert.equal(useIntakeSession.getState().text, "new.example.com");
  assert.equal(useIntakeSession.getState().result, before);
});

test("整理等待中手动改字段，模型回答不能抹掉人工修改", () => {
  startSession();
  const session = useIntakeSession.getState();
  const before = session.result!;
  const id = session.startRun()!;
  session.updateBundle((bundle) => editField(bundle, 0, "name", "reviewed.example.com")!);
  assert.equal(session.finishRun(id, before), false);
  assert.equal(useIntakeSession.getState().result!.bundle.entries[0].title, "reviewed.example.com");
  assert.equal(useIntakeSession.getState().history.length, 1);
});

test("清空结果会作废整理，迟到的回答不能让结果重新出现", () => {
  startSession();
  const session = useIntakeSession.getState();
  const before = session.result!;
  const id = session.startRun()!;
  session.setResult(null);
  assert.equal(session.finishRun(id, before), false);
  assert.equal(useIntakeSession.getState().result, null);
  assert.equal(useIntakeSession.getState().pendingRun, null);
});

test("等待期间撤销人工改动，迟到结果不能恢复被撤销的内容", () => {
  startSession();
  const session = useIntakeSession.getState();
  const before = session.result!;
  session.updateBundle((bundle) => setEntryIgnored(bundle, 0, true));
  const id = session.startRun()!;
  session.undo();
  assert.equal(session.finishRun(id, before), false);
  assert.ok(!useIntakeSession.getState().result!.bundle.entries[0].ignored);
  assert.equal(useIntakeSession.getState().history.length, 0);
});

test("过期请求的成功或失败都不能结束新一轮整理", () => {
  startSession();
  const session = useIntakeSession.getState();
  const before = session.result!;
  const first = session.startRun()!;
  session.setText("replacement.example.com");
  const latest = session.startRun()!;
  assert.notEqual(first, latest);
  assert.equal(session.finishRun(first, before), false);
  assert.equal(session.endRun(first, "过期请求失败"), false);
  assert.equal(useIntakeSession.getState().runError, "");
  assert.equal(useIntakeSession.getState().pendingRun, latest);
  assert.equal(session.finishRun(latest, before), true);
});

test("自动刷新资料对照和无变化的编辑不会作废当前整理", () => {
  startSession();
  const session = useIntakeSession.getState();
  const id = session.startRun()!;
  session.setText("");
  session.updateBundle((bundle) => bundle);
  session.updateBundle(
    (bundle) =>
      refreshSaved(bundle, {
        domains: [{ id: "saved", name: "example.com" }],
      } as Partial<Snapshot>),
    false,
  );
  assert.equal(useIntakeSession.getState().pendingRun, id);
  assert.equal(session.endRun(id), true);
});

test("整理请求失败的信息跨面板保留，重新编辑或重试后清除", () => {
  startSession();
  const session = useIntakeSession.getState();
  const id = session.startRun()!;
  assert.equal(session.endRun(id, "模型请求超时，请重试"), true);
  assert.equal(useIntakeSession.getState().runError, "模型请求超时，请重试");
  const next = session.startRun()!;
  assert.equal(useIntakeSession.getState().runError, "");
  session.endRun(next, "模型暂不可用");
  session.setText("revised.example.com");
  assert.equal(useIntakeSession.getState().runError, "");
});

test("模型回退到本地规则时仍保留可见原因", () => {
  startSession();
  const session = useIntakeSession.getState();
  const id = session.startRun()!;
  const fallback = { ...session.result!, error: "模型不可用，保留本地整理结果" };
  assert.equal(session.finishRun(id, fallback), true);
  assert.equal(useIntakeSession.getState().runError, fallback.error);
  assert.equal(useIntakeSession.getState().result, fallback);
});
