"use client";

import { Play, RotateCcw, Square } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import type { V1TimelineBrowserPlayback } from "./V1TimelineRail";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./TimelineTransportControls.stylex";

export function TimelineTransportControls({
  playback,
  playDisabled = false,
  className,
}: {
  playback?: V1TimelineBrowserPlayback | null;
  playDisabled?: boolean;
  className?: string;
}) {
  const ready = Boolean(playback?.sessionId);
  const playing = Boolean(playback?.playing);

  return (
    <div
      className={cn(stylex.props(styles.flexCenterWhite).className, className)}
      data-testid="timeline-transport-controls"
    >
      <TransportButton
        disabled={!ready || playDisabled}
        label={playing ? "Stop scenario" : "Play scenario"}
        onClick={() => {
          if (playing) playback?.onStop();
          else playback?.onPlay();
        }}
      >
        {playing ? (
          <Square aria-hidden="true" className={stylex.props(styles.size25FillCurrent).className} />
        ) : (
          <Play aria-hidden="true" className={stylex.props(styles.size3FillCurrent).className} />
        )}
      </TransportButton>
      <TransportButton
        disabled={!ready}
        label="Reset scenario"
        onClick={() => playback?.onReset()}
      >
        <RotateCcw aria-hidden="true" className={stylex.props(styles.size3).className} />
      </TransportButton>
    </div>
  );
}

function TransportButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      aria-label={label}
      xstyle={styles.whitePad0}
      disabled={disabled}
      onClick={onClick}
      size="icon"
      title={label}
      type="button"
      variant="ghost"
    >
      {children}
    </Button>
  );
}
