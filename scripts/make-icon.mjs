#!/usr/bin/env node
/** 从共享矢量标记生成 PNG、Windows 多尺寸 ICO、网站图标及品牌预览。 */
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { BRAND_MARK, brandSvg } from "../src/lib/brand-mark.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const C = BRAND_MARK.colors;

async function saveInstallerBitmap(page, width, height, html, filename) {
  await page.setViewportSize({ width, height });
  await page.setContent(html);
  await page.screenshot({ path: join(root, `build/${filename}.png`) });
  // NSIS 需要无压缩 BMP；从同一页面取像素，避免再引入平台图像工具。
  const pixels = await page.evaluate(async () => {
    const svg = document.querySelector("svg");
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = innerWidth;
      canvas.height = innerHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法生成安装器图像。");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  const stride = Math.ceil((width * 3) / 4) * 4;
  const bitmap = Buffer.alloc(54 + stride * height);
  bitmap.write("BM");
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(width, 18);
  bitmap.writeInt32LE(height, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(24, 28);
  bitmap.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      const target = 54 + (height - y - 1) * stride + x * 3;
      bitmap[target] = pixels[source + 2];
      bitmap[target + 1] = pixels[source + 1];
      bitmap[target + 2] = pixels[source];
    }
  await writeFile(join(root, `build/${filename}.bmp`), bitmap);
}
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
  for (const size of [16, 32, 48, 128, 180, 192, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.screenshot({
      path: join(root, `public/brand/icon-${size}.png`),
      omitBackground: true,
    });
  }
  // 主屏幕会按系统形状裁切，底色铺满后不会在圆角外出现白边。
  await page.addStyleTag({ content: `html,body{background:${C.ink}}` });
  for (const size of [180, 192, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.screenshot({ path: join(root, `public/brand/icon-maskable-${size}.png`) });
  }
  await writeFile(
    join(root, "public/manifest.webmanifest"),
    JSON.stringify(
      {
        name: "Helself",
        short_name: "Helself",
        id: "/",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: C.paper,
        theme_color: C.ink,
        icons: [192, 512].flatMap((size) => [
          {
            src: `/brand/icon-${size}.png`,
            sizes: `${size}x${size}`,
            type: "image/png",
            purpose: "any",
          },
          {
            src: `/brand/icon-maskable-${size}.png`,
            sizes: `${size}x${size}`,
            type: "image/png",
            purpose: "maskable",
          },
        ]),
      },
      null,
      2,
    ) + "\n",
  );
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
  const sidebar = `<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314" viewBox="0 0 164 314"><rect width="164" height="314" fill="${C.ink}"/><g transform="translate(38 46) scale(1.375)">${icon.replace(/<svg[^>]*>|<\/svg>/g, "")}</g><text x="82" y="176" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="26" font-weight="600" fill="${C.paper}">Helself</text><path d="M58 201h48" stroke="${C.lime}" stroke-width="3"/><text x="82" y="247" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="10" fill="${C.paper}">YOUR PERSONAL</text><text x="82" y="265" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="10" fill="${C.paper}">WORKSPACE</text></svg>`;
  const installerHeader = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="57" viewBox="0 0 150 57"><rect width="150" height="57" fill="white"/><g transform="translate(6 8) scale(.64)">${icon.replace(/<svg[^>]*>|<\/svg>/g, "")}</g><text x="57" y="36" font-family="Segoe UI,Arial,sans-serif" font-size="21" font-weight="600" fill="${C.ink}">Helself</text></svg>`;
  await saveInstallerBitmap(
    page,
    164,
    314,
    `<style>body{margin:0}</style>${sidebar}`,
    "installerSidebar",
  );
  await saveInstallerBitmap(
    page,
    150,
    57,
    `<style>body{margin:0}</style>${installerHeader}`,
    "installerHeader",
  );
} finally {
  await browser.close();
}
console.log("Helself PNG / ICO / SVG 与品牌预览已生成");
