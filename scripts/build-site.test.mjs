import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { releaseDetails, renderSite, siteDetails } from "./build-site.mjs";

const runNode = promisify(execFile);

function publishedRelease(version = "1.2.3") {
  const base = `https://github.com/addxiaoyi/HEL-SEIF/releases`;
  return {
    tag_name: `v${version}`,
    name: `Helself ${version}`,
    draft: false,
    prerelease: false,
    html_url: `${base}/tag/v${version}`,
    published_at: "2026-10-07T06:27:45Z",
    body: "# Helself\n\n修复 Windows 任务栏旧图标，保留原资料。\n\n## 修复内容\n\n- 具体说明",
    assets: [
      `Nanpad-${version}-setup.exe`,
      `Nanpad-${version}-browser-extension.zip`,
      "SHA256SUMS.txt",
    ].map((name) => ({
      name,
      size: 114856991,
      state: "uploaded",
      browser_download_url: `${base}/download/v${version}/${name}`,
    })),
  };
}

test("只有明确的 null 使用待发布状态，其他无效发布对象仍然拒绝", () => {
  assert.deepEqual(siteDetails(null), {
    PUBLISHED: false,
    RELEASE_URL: "https://github.com/addxiaoyi/HEL-SEIF/releases",
  });
  for (const invalid of [{}, [], undefined, false, "", { draft: false }])
    assert.throws(() => siteDetails(invalid), /published stable release/i);
  const release = publishedRelease();
  assert.deepEqual(siteDetails(release), { ...releaseDetails(release), PUBLISHED: true });
  release.assets = [];
  assert.throws(() => siteDetails(release), /asset/i);
});

test("模板只保留对应的发布状态，不解析发布说明里的条件标记", () => {
  const template =
    "<!-- IF_PUBLISHED -->published {{VERSION}}<!-- END_IF_PUBLISHED -->" +
    "<!-- IF_UNPUBLISHED -->pending<!-- END_IF_UNPUBLISHED -->";
  assert.equal(renderSite(template, siteDetails(null)), "pending");
  assert.equal(renderSite(template, siteDetails(publishedRelease())), "published 1.2.3");
  assert.throws(() => renderSite(template, {}), /release state/i);
  const release = publishedRelease();
  release.body = "发布说明 <!-- IF_UNPUBLISHED -->不作为条件执行<!-- END_IF_UNPUBLISHED -->";
  assert.match(renderSite("{{RELEASE_SUMMARY}}", siteDetails(release)), /&lt;!-- IF_UNPUBLISHED/);
});

test("CLI 完整构建同时支持待发布与真实正式版，损坏的发布信息不生成站点", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "helself-site-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const releaseFile = join(directory, "release.json");
  const script = fileURLToPath(new URL("./build-site.mjs", import.meta.url));
  for (const release of [null, publishedRelease("1.17.3")]) {
    const output = join(directory, release === null ? "pending" : "published");
    await writeFile(releaseFile, JSON.stringify(release));
    const { stdout } = await runNode(process.execPath, [script, releaseFile, output]);
    const verdict = JSON.parse(stdout);
    assert.equal(verdict.published, release !== null);
    assert.equal(verdict.version, release === null ? null : "1.17.3");
    for (const page of ["index.html", "guide.html", "sync.html"]) {
      const html = await readFile(join(output, page), "utf8");
      assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}|<!-- (?:END_)?IF_/);
      assert.match(html, /data-app-ready="true"/);
      assert.doesNotMatch(html, /<video\b/i);
      if (release === null) {
        assert.doesNotMatch(html, /releases\/download\/|Helself-.*?-setup\.exe|<time\b/);
        if (page !== "sync.html") assert.match(html, /尚无正式版/);
      } else {
        assert.doesNotMatch(html, /尚无正式版/);
        if (page !== "sync.html") assert.match(html, /1\.17\.3/);
      }
    }
    const metadata = JSON.parse(await readFile(join(output, "release.json"), "utf8"));
    assert.deepEqual(metadata, release === null ? null : siteDetails(release));
    for (const file of ["style.css", "icon.png", "sync.js", "zsp-steps.json"])
      await access(join(output, file));
    assert.equal(
      (await readdir(output)).some((file) => /\.(?:mp4|webm|mov)$/i.test(file)),
      false,
    );
  }
  const invalidOutput = join(directory, "invalid");
  await writeFile(releaseFile, "{}");
  await assert.rejects(runNode(process.execPath, [script, releaseFile, invalidOutput]));
  await assert.rejects(access(invalidOutput));
});

test("统一品牌后的下载页支持新安装包名，同时兼容历史附件", () => {
  const release = publishedRelease("1.6.0");
  for (const asset of release.assets) {
    asset.name = asset.name.replace("Nanpad-", "Helself-");
    asset.browser_download_url = asset.browser_download_url.replace("Nanpad-", "Helself-");
  }
  assert.match(releaseDetails(release).INSTALLER_URL, /Helself-1\.6\.0-setup\.exe$/);
});

test("在线安装器采用真实附件大小，拒绝异常下载地址并兼容旧版", () => {
  const release = publishedRelease("1.17.2");
  const name = "Helself-1.17.2-online-setup.exe";
  const entry = {
    name,
    size: 70144,
    state: "uploaded",
    browser_download_url: `https://github.com/addxiaoyi/HEL-SEIF/releases/download/v1.17.2/${name}`,
  };
  release.assets.push(entry);
  assert.equal(releaseDetails(release).ONLINE_INSTALLER_URL, entry.browser_download_url);
  assert.match(releaseDetails(release).ONLINE_INSTALLER_NOTE, /69 KB/);
  entry.browser_download_url = "https://example.invalid/setup.exe";
  assert.throws(() => releaseDetails(release), /URL/);
  assert.equal(
    releaseDetails(publishedRelease()).ONLINE_INSTALLER_URL,
    publishedRelease().html_url,
  );
});

test("宣传页以已发布版本为准，同步全部下载入口与更新摘要", () => {
  const details = releaseDetails(publishedRelease("1.2.4"));
  assert.equal(details.VERSION, "1.2.4");
  assert.equal(details.RELEASE_DATE, "2026年10月7日");
  assert.equal(details.RELEASE_SUMMARY, "修复 Windows 任务栏旧图标，保留原资料。");
  assert.match(details.INSTALLER_URL, /v1\.2\.4\/Nanpad-1\.2\.4-setup\.exe$/);
  assert.match(details.EXTENSION_URL, /v1\.2\.4\/Nanpad-1\.2\.4-browser-extension\.zip$/);
  assert.match(details.CHECKSUM_URL, /v1\.2\.4\/SHA256SUMS\.txt$/);
  // 没有便携版附件的旧版本退回到 Release 页面。
  assert.equal(details.PORTABLE_URL, details.RELEASE_URL);
});

test("有便携版附件时，下载页直接链接便携版", () => {
  const release = publishedRelease("1.9.0");
  for (const asset of release.assets) {
    asset.name = asset.name.replace("Nanpad-", "Helself-");
    asset.browser_download_url = asset.browser_download_url.replace("Nanpad-", "Helself-");
  }
  const name = "Helself-1.9.0-portable-x64.zip";
  release.assets.push({
    name,
    size: 160_000_000,
    state: "uploaded",
    browser_download_url: `https://github.com/addxiaoyi/HEL-SEIF/releases/download/v1.9.0/${name}`,
  });
  const details = releaseDetails(release);
  assert.match(details.PORTABLE_URL, /portable-x64\.zip$/);
  assert.equal(details.PORTABLE_SIZE, "160 MB");
});

test("未正式发布或附件尚未上传完成时拒绝部署", () => {
  for (const patch of [
    { draft: true },
    { prerelease: true },
    { published_at: null },
    { tag_name: "v1.3.0-beta" },
  ]) {
    assert.throws(() => releaseDetails({ ...publishedRelease(), ...patch }));
  }
  for (const name of ["setup.exe", "browser-extension.zip", "SHA256SUMS.txt"]) {
    const release = publishedRelease();
    release.assets = release.assets.filter((asset) => !asset.name.endsWith(name));
    assert.throws(() => releaseDetails(release), /asset/i);
  }
  const uploading = publishedRelease();
  uploading.assets[0].state = "new";
  assert.throws(() => releaseDetails(uploading), /asset/i);
});

test("下载链接只接受当前仓库、当前版本及对应附件", () => {
  for (const url of [
    "javascript:alert(1)",
    "https://github.com.evil.test/setup.exe",
    "https://github.com/addxiaoyi/HEL-SEIF/releases/download/v0.1.0/Nanpad-0.1.0-setup.exe",
  ]) {
    const release = publishedRelease();
    release.assets[0].browser_download_url = url;
    assert.throws(() => releaseDetails(release), /URL/);
  }
});

test("发布说明按文本输出，不能把脚本或模板占位符带进网页", () => {
  const release = publishedRelease();
  release.body = '# 标题\n\n<img src=x onerror="alert(1)"> & {{VERSION}}';
  const html = renderSite("<p>{{RELEASE_SUMMARY}}</p><b>{{VERSION}}</b>", releaseDetails(release));
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("&quot;"));
  assert.ok(html.endsWith("<b>1.2.3</b>"));
  assert.ok(html.includes("{{VERSION}}"), "说明里的文本不作为二次模板执行");
  assert.throws(() => renderSite("{{UNKNOWN}}", releaseDetails(release)), /Unknown/);
});

test("没有正文时回退到发布标题，长说明保持简短", () => {
  assert.equal(
    releaseDetails({ ...publishedRelease(), body: "" }).RELEASE_SUMMARY,
    "Helself 1.2.3",
  );
  assert.ok(
    releaseDetails({ ...publishedRelease(), body: "新".repeat(1000) }).RELEASE_SUMMARY.length <=
      221,
  );
});

test("同步协议动画：分镜自洽，动画 SVG 与分镜同步，页面模板的占位符都有值", async () => {
  const { readFile } = await import("node:fs/promises");
  const { buildSvg } = await import("./build-zsp-svg.mjs");
  const storyboard = JSON.parse(await readFile("site/zsp-steps.json", "utf8"));
  const chapters = new Set(storyboard.chapters.map((chapter) => chapter.id));
  const ids = new Set();
  const actors = new Set(["desktop", "server"]);
  for (const step of storyboard.steps) {
    assert.ok(!ids.has(step.id), `步骤 id 重复：${step.id}`);
    ids.add(step.id);
    assert.ok(chapters.has(step.chapter), `${step.id} 的章节不存在`);
    for (const field of ["title", "what", "why", "seen"])
      assert.ok(
        typeof step[field] === "string" && step[field].length > 4,
        `${step.id} 缺少 ${field}`,
      );
    for (const packet of step.packets ?? []) {
      assert.ok(
        actors.has(packet.from) && actors.has(packet.to) && packet.from !== packet.to,
        step.id,
      );
      assert.ok(packet.label?.length > 0, step.id);
    }
    if (step.chapter === "attack")
      assert.ok(step.attacker?.result && step.attacker.target, step.id);
    else assert.equal(step.attacker, undefined, `${step.id} 只有攻击章节才有攻击者`);
  }
  assert.ok(storyboard.steps.some((step) => step.readme));
  assert.equal(
    buildSvg(storyboard),
    await readFile("site/zsp-flow.svg", "utf8"),
    "分镜改过后请运行 node scripts/build-zsp-svg.mjs 重新生成 site/zsp-flow.svg",
  );
  for (const file of ["site/sync.html", "site/index.html", "site/guide.html"]) {
    const html = await readFile(file, "utf8");
    const values = {
      PUBLISHED: true,
      VERSION: "1.2.3",
      ASSET_REVISION: "abc",
      STEP_COUNT: storyboard.steps.length,
      RELEASE_DATE: "d",
      RELEASE_ISO_DATE: "d",
      RELEASE_SUMMARY: "s",
      RELEASE_URL: "u",
      INSTALLER_URL: "u",
      INSTALLER_SIZE: "1 MB",
      ONLINE_INSTALLER_URL: "u",
      ONLINE_INSTALLER_NOTE: "69 KB",
      EXTENSION_URL: "u",
      CHECKSUM_URL: "u",
      PORTABLE_URL: "u",
      PORTABLE_SIZE: "1 MB",
    };
    assert.doesNotMatch(renderSite(html, values), /\{\{[A-Z_]+\}\}/, file);
  }
});
