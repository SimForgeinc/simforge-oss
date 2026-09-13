"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./map-assets.stylex";

import { useRef, useState, useCallback, useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";

type Props = {
  proxyUrl: string;
  label?: string;
  assetName: string;
  /** Current player width in px (controlled by the parent so size persists across opens). */
  width?: number;
  onWidthChange?: (width: number) => void;
  onClose: () => void;
};

const MIN_WIDTH = 280;
const DEFAULT_WIDTH = 480;
const DEFAULT_ASPECT = 16 / 9;
const MAX_RATIO = 0.8; // never exceed 80% of the map area in either dimension
const HEADER_HEIGHT = 32; // slim header (h-8)

/**
 * Compact fly-by video player, pinned to the bottom-right of the map. The box
 * is locked to the clip's aspect ratio (no letterbox); the user can drag the
 * top-left corner to resize and still use the native fullscreen control.
 */
export function MapMediaPanel({
  proxyUrl,
  label,
  assetName,
  width = DEFAULT_WIDTH,
  onWidthChange,
  onClose,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  // Latest width without re-subscribing the ResizeObserver on every drag pixel.
  const widthRef = useRef(width);
  widthRef.current = width;

  const videoHeight = Math.round(width / aspect);

  // Clamp a desired width to [MIN_WIDTH, 80% of the map area] honoring the
  // current aspect ratio (so neither dimension overflows the map).
  const clampWidth = useCallback(
    (desired: number) => {
      const parent = panelRef.current?.offsetParent as HTMLElement | null;
      let maxWidth = Infinity;
      if (parent) {
        const maxByWidth = parent.clientWidth * MAX_RATIO;
        const maxByHeight = (parent.clientHeight * MAX_RATIO - HEADER_HEIGHT) * aspect;
        maxWidth = Math.max(MIN_WIDTH, Math.min(maxByWidth, maxByHeight));
      }
      return Math.max(MIN_WIDTH, Math.min(desired, maxWidth));
    },
    [aspect],
  );

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragState.current = { startX: e.clientX, startWidth: width };

      function onMove(ev: MouseEvent) {
        if (!dragState.current) return;
        const delta = dragState.current.startX - ev.clientX; // drag left = grow
        onWidthChange?.(clampWidth(dragState.current.startWidth + delta));
      }
      function onUp() {
        dragState.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, onWidthChange, clampWidth],
  );

  // Re-clamp on mount, when the aspect ratio resolves, and whenever the map
  // area resizes (e.g. a side panel expands), so the player never exceeds 80%.
  useEffect(() => {
    onWidthChange?.(clampWidth(widthRef.current));
    const parent = panelRef.current?.offsetParent as HTMLElement | null;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => onWidthChange?.(clampWidth(widthRef.current)));
    ro.observe(parent);
    return () => ro.disconnect();
  }, [clampWidth, onWidthChange]);

  return (
    <div
      ref={panelRef}
      className={stylex.props(styles.s_127).className}
      style={{ width }}
    >
      {/* Resize handle — top-left corner; drag toward the map center to grow. */}
      <div
        onMouseDown={onDragStart}
        className={stylex.props(styles.s_128).className}
        title="Drag to resize"
      >
        <div className={stylex.props(styles.s_129).className} />
      </div>

      {/* Slim header */}
      <div className={stylex.props(styles.s_130).className}>
        <span className={stylex.props(styles.s_131).className}>
          {label ? `${assetName} — ${label}` : `${assetName} — fly-by video`}
        </span>
        <Button
          variant="ghost"
          size="icon"
          xstyle={styles.s_132}
          onClick={onClose}
          aria-label="Close video panel"
        >
          <X className={stylex.props(styles.s_991).className} />
        </Button>
      </div>

      {/* Video — the box matches the clip's aspect ratio, so there is no
          letterbox. key remounts on URL change to reset playback + re-fire
          autoPlay; autoPlay is allowed (even with audio) because opening this
          panel is driven by the user's click on the preview's play overlay. */}
      <div className={stylex.props(styles.s_134).className} style={{ height: videoHeight }}>
        <video
          key={proxyUrl}
          controls
          autoPlay
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
          }}
          className={stylex.props(styles.s_135).className}
        >
          <source src={proxyUrl} type="video/mp4" />
          Your browser does not support video playback.
        </video>
      </div>
    </div>
  );
}
