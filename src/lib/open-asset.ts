import type { MouseEvent } from "react";
import type { AssetKind } from "./types";
import { useAppStore } from "./store";

export function openFromEvent(e: MouseEvent<HTMLElement>, kind: AssetKind, id: string) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  useAppStore.getState().setExpanded({
    kind,
    id,
    origin: { x: r.left, y: r.top, w: r.width, h: r.height },
  });
}
