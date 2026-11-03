/**
 * Helself 标志：两根圆头立柱与一道横梁构成 H，横梁正中嵌一颗亮色核心。
 * 图标用深色圆角底板（纸白立柱 + 亮绿核心）；界面内用透明版本，立柱跟随文字颜色。
 * 同一几何用于界面、安装图标、网站图标、分享卡与浏览器插件。
 */

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

export const BRAND_MARK = {
  /** 图标底板使用的完整视图。 */
  viewBox: "0 0 64 64",
  /** 透明标记裁到图形附近，界面里小尺寸也能撑满。 */
  markViewBox: "11 11 42 42",
  /** @type {Rect[]} */
  columns: [
    { x: 16, y: 14, width: 8, height: 36 },
    { x: 40, y: 14, width: 8, height: 36 },
  ],
  columnRadius: 4,
  /** @type {Rect & { radius: number }} */
  beam: { x: 22, y: 28.75, width: 20, height: 6.5, radius: 3.25 },
  core: { cx: 32, cy: 32, r: 6 },
  tile: { radius: 15 },
  colors: {
    ink: "#111315",
    paper: "#F6F3EA",
    lime: "#C8F169",
    pine: "#1D5B4A",
    mint: "#7FE0BF",
    clay: "#F2764F",
  },
};

/** @param {Rect} rect @param {number} radius */
function rect(rect, radius) {
  return `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" rx="${radius}"/>`;
}

/**
 * 透明标记：立柱与横梁跟随文字颜色，核心固定为品牌亮色。
 * @param {{ frame?: string, core?: string, tile?: boolean }} [options]
 */
export function brandMark(options = {}) {
  const { frame = "currentColor", core = BRAND_MARK.colors.lime } = options;
  const m = BRAND_MARK;
  const frameRects = [...m.columns.map((column) => rect(column, m.columnRadius)), rect(m.beam, m.beam.radius)].join("");
  return `<g fill="${frame}">${frameRects}</g><circle cx="${m.core.cx}" cy="${m.core.cy}" r="${m.core.r}" fill="${core}"/>`;
}

/** 深色圆角底板版本，用于图标、网站图标与分享卡。 */
export function brandIcon() {
  const m = BRAND_MARK;
  return `<rect x="0" y="0" width="64" height="64" rx="${m.tile.radius}" fill="${m.colors.ink}"/>${brandMark({ frame: m.colors.paper })}`;
}

/**
 * 输出独立的 SVG 文本。
 * @param {{ tile?: boolean, size?: number, frame?: string }} [options]
 */
export function brandSvg(options = {}) {
  const { tile = true, size = 64, frame } = options;
  const inner = tile ? brandIcon() : brandMark(frame ? { frame } : {});
  const viewBox = tile ? BRAND_MARK.viewBox : BRAND_MARK.markViewBox;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${size}" height="${size}" fill="none">${inner}</svg>`;
}
