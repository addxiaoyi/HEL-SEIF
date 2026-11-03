#!/usr/bin/env node
/** 从共享矢量标记生成 PNG、Windows 多尺寸 ICO、网站图标及品牌预览。 */
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { BRAND_MARK, brandSvg } from "../src/lib/brand-mark.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const C = BRAND_MARK.colors;
await mkdir(join(root, "build"), { recursive: true });
await mkdir(join(root, "public/brand"), { recursive: true });
const icon = brandSvg();
const mark = brandSvg({ tile: false, frame: C.pine });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{width:100vw;height:100vh;display:block}</style>${icon}`,
  );
  await page.screenshot({ path: join(root, "build/icon.png"), omitBackground: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = [];
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    frames.push(await page.screenshot({ omitBackground: true }));
  }
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const base = 6 + i * 16;
    header[base] = header[base + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, base + 4);
    header.writeUInt16LE(32, base + 6);
    header.writeUInt32LE(frames[i].length, base + 8);
    header.writeUInt32LE(offset, base + 12);
    offset += frames[i].length;
  });
  await writeFile(join(root, "build/icon.ico"), Buffer.concat([header, ...frames]));
  // 三处网站图标共用同一个矢量源：应用、产品主页与自托管网页版。
  for (const target of ["public/favicon.svg", "site/favicon.svg", "selfhost/public/favicon.svg"])
    await writeFile(join(root, target), icon + "\n");
  await writeFile(join(root, "public/brand/helself.svg"), icon + "\n");
  await writeFile(join(root, "public/brand/helself-mark.svg"), mark + "\n");
  await copyFile(join(root, "build/icon.png"), join(root, "site/icon.png"));
  await copyFile(join(root, "build/icon.png"), join(root, "public/brand/helself.png"));
  await page.setViewportSize({ width: 1200, height: 720 });
  await page.setContent(
    `<style>*{box-sizing:border-box}body{margin:0;background:${C.paper};font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:${C.ink}}.board{display:grid;grid-template-columns:1.25fr 1fr;height:720px}.hero{padding:82px 72px;display:flex;flex-direction:column;align-items:flex-start;border-right:1px solid #e0dcd0}.eyebrow{font-size:14px;letter-spacing:4px;color:#6b6b64;margin-bottom:45px}.hero svg{width:174px;height:174px}.name{font-size:54px;letter-spacing:0;font-weight:650;margin-top:26px}.english{font-size:19px;letter-spacing:6px;margin-top:8px;color:#6b6b64}.tagline{font-size:19px;margin-top:32px;color:#6b6b64}.examples{display:flex;flex-direction:column}.dark{background:${C.ink};color:${C.paper};padding:70px 48px;flex:1}.label{font-size:12px;letter-spacing:3px;opacity:.7;margin-bottom:32px}.lockup{display:flex;align-items:center;gap:20px;font-size:32px;font-weight:600}.lockup svg{width:64px;height:64px}.light{padding:48px;background:#ecebe4;flex:1}.sizes{display:flex;align-items:center;gap:26px;margin:30px 0}.sizes svg{flex-shrink:0}.note{font-size:14px;line-height:1.8;color:#6b6b64}.core{color:${C.pine}}</style><div class="board"><div class="hero"><div class="eyebrow">A PLACE FOR WHAT YOU KNOW</div>${icon}<div class="name">Helself</div><div class="english">PERSONAL WORKSPACE</div><div class="tagline">让资料相连，让知识有处安放。</div></div><div class="examples"><div class="dark"><div class="label">YOUR CONNECTED WORKSPACE</div><div class="lockup">${icon}<span>Helself</span></div><div style="margin-top:26px;opacity:.75;font-size:16px">文档 · 账号 · 资产 · AI</div></div><div class="light"><div class="label">CLEAR AT EVERY SIZE</div><div class="sizes">${[64, 40, 24, 16].map((size) => icon.replace('width="64" height="64"', `width="${size}" height="${size}"`)).join("")}</div><div class="note">两根立柱与一道横梁构成 H，<br>横梁正中是亮绿核心。<br><span class="core">透明版跟随文字颜色 · 共享矢量源</span></div></div></div></div>`,
  );
  await page.screenshot({ path: join(root, "public/brand/helself-preview.png") });
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.addStyleTag({
    content:
      ".board{height:630px}.hero{padding:52px 72px}.dark{padding:50px 48px}.light{padding:32px 48px}",
  });
  await page.screenshot({ path: join(root, "public/og.jpg"), type: "jpeg", quality: 90 });
} finally {
  await browser.close();
}
console.log("Helself PNG / ICO / SVG 与品牌预览已生成");
