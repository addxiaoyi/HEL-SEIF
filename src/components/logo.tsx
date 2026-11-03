import { t } from "@/lib/i18n";
import { BRAND_MARK } from "@/lib/brand-mark.mjs";

/** 界面与安装图标共用同一透明标记：双立柱与横梁构成 H，核心用品牌亮绿。 */
export function LogoMark({ className = "size-9" }: { className?: string }) {
  const m = BRAND_MARK;
  return (
    <svg viewBox={m.markViewBox} className={className} fill="none" aria-hidden="true" data-brand-mark>
      {m.columns.map((column: { x: number; y: number; width: number; height: number }) => (
        <rect
          key={column.x}
          x={column.x}
          y={column.y}
          width={column.width}
          height={column.height}
          rx={m.columnRadius}
          fill="currentColor"
        />
      ))}
      <rect
        x={m.beam.x}
        y={m.beam.y}
        width={m.beam.width}
        height={m.beam.height}
        rx={m.beam.radius}
        fill="currentColor"
      />
      <circle cx={m.core.cx} cy={m.core.cy} r={m.core.r} fill={m.colors.lime} />
    </svg>
  );
}

export function LogoWord() {
  return (
    <div className="flex items-center gap-3">
      <LogoMark />
      <div className="leading-tight">
        <div className="text-lg font-bold tracking-wordmark">{t("Helself")}</div>
        <div className="text-2xs text-muted">{t("个人知识与资产空间")}</div>
      </div>
    </div>
  );
}
