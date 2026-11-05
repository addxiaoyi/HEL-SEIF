import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { BRAND_MARK, brandSvg } from "../src/lib/brand-mark.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url));
const json = async (path) => JSON.parse(await read(path));
const pngSize = (bytes) => {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

test("all browser favicons use the shared Helself vector", async () => {
  for (const path of [
    "public/favicon.svg",
    "site/favicon.svg",
    "selfhost/public/favicon.svg",
    "public/brand/helself.svg",
  ])
    assert.equal((await read(path)).toString().trim(), brandSvg());
});

test("Windows icon contains every supported size and real PNG frames", async () => {
  const icon = await read("build/icon.ico");
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), sizes.length);
  for (const [index, size] of sizes.entries()) {
    const offset = 6 + index * 16;
    const length = icon.readUInt32LE(offset + 8);
    const start = icon.readUInt32LE(offset + 12);
    assert.ok(start + length <= icon.length);
    assert.deepEqual(pngSize(icon.subarray(start, start + length)), [size, size]);
  }
});

test("home screen icons are named, correctly sized and maskable", async () => {
  const manifest = await json("public/manifest.webmanifest");
  assert.equal(manifest.name, "Helself");
  assert.equal(manifest.theme_color, BRAND_MARK.colors.ink);
  assert.equal(manifest.icons.length, 4);
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\/brand\/icon-(maskable-)?(192|512)\.png$/);
    assert.deepEqual(pngSize(await read(`public${icon.src}`)), icon.sizes.split("x").map(Number));
  }
  assert.deepEqual(pngSize(await read("public/brand/icon-maskable-180.png")), [180, 180]);
});

test("extension toolbar and management page declare size-specific brand icons", async () => {
  const manifest = await json("browser-extension/manifest.json");
  for (const size of [16, 32, 48, 128]) {
    assert.equal(manifest.icons[size], `icons/app-${size}.png`);
    assert.deepEqual(pngSize(await read(`public/brand/icon-${size}.png`)), [size, size]);
  }
  assert.deepEqual(Object.keys(manifest.action.default_icon), ["16", "32"]);
});

test("package, lock and extension share one candidate version", async () => {
  const manifest = await json("package.json");
  const lock = await json("package-lock.json");
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.equal((await json("browser-extension/manifest.json")).version, manifest.version);
});

test("offline installer has correctly sized branded BMP artwork", async () => {
  for (const [name, width, height] of [
    ["installerSidebar", 164, 314],
    ["installerHeader", 150, 57],
  ]) {
    const bytes = await read(`build/${name}.bmp`);
    assert.equal(bytes.subarray(0, 2).toString(), "BM");
    assert.equal(bytes.readUInt32LE(2), bytes.length);
    assert.equal(bytes.readInt32LE(18), width);
    assert.equal(bytes.readInt32LE(22), height);
    assert.equal(bytes.readUInt16LE(28), 24);
  }
});
