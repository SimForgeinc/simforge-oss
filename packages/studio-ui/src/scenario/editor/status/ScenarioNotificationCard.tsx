"use client";

import {
  AlertTriangle,
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  Info,
  LoaderCircle,
  X,
} from "lucide-react";
import { Button } from "../../../components/ui/button";
import type {
  NotificationGroup,
  NotificationSeverity,
} from "./notification-model";
import { useCopyToClipboard } from "../../list/CopyableErrorMessage";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioNotificationCard.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

const SEVERITY_ICON = {
  error: CircleAlert,
  warning: AlertTriangle,
  success: CircleCheck,
  info: Info,
  progress: LoaderCircle,
} as const;

const SEVERITY_CHROME: Record<NotificationSeverity, stylex.StyleXStyles> = {
  error: styles.cardError,
  warning: styles.cardWarning,
  success: styles.cardSuccess,
  info: styles.cardNeutral,
  progress: styles.cardNeutral,
};

export function ScenarioNotificationCard({
  group,
  onDismiss,
}: {
  group: NotificationGroup;
  onDismiss: (keys: string[]) => void;
}) {
  const { notification, count, keys } = group;
  const { severity, source, message, detail, progress, action } = notification;
  const isError = severity === "error";
  const Icon = SEVERITY_ICON[severity];
  const { copied, copy } = useCopyToClipboard();

  return (
    <div
      aria-live={isError ? "assertive" : "polite"}
      {...stylex.props(styles.card, SEVERITY_CHROME[severity], progress != null && styles.cardWithProgress)}
      data-severity={severity}
      data-source={source}
      data-testid="scenario-notification-card"
      role={isError ? "alert" : "status"}
    >
      <div {...stylex.props(styles.flexStartGap2)}>
        <Icon
          aria-hidden="true"
          className={stylex.props(styles.icon, severity === "progress" && styles.iconSpinning).className}
        />
        <div {...stylex.props(styles.fillNarrowable)}>
          <div {...stylex.props(styles.flexCenterGap15)}>
            <span {...stylex.props(styles.capsMicroBold)}>
              {source}
            </span>
            {count > 1 ? (
              <span
                {...stylex.props(styles.microBoldBordered)}
                data-testid="scenario-notification-count"
                title={`${count} notifications say this`}
              >
                ×{count}
              </span>
            ) : null}
            {progress != null ? (
              <span {...stylex.props(styles.metaMediumPushRight)}>
                {progress}%
              </span>
            ) : null}
          </div>
          <div {...stylex.props(styles.smMediumSnug)}>
            {message}
          </div>
          {detail ? (
            <div {...stylex.props(styles.xsSnug)}>
              {detail}
            </div>
          ) : null}
          {action ? (
            <Button
              xstyle={styles.xs}
              size="sm"
              variant="outline"
              onClick={action.run}
            >
              {action.label}
            </Button>
          ) : null}
        </div>
        <button
          type="button"
          aria-label={
            copied
              ? `${message} copied to clipboard`
              : `Copy ${message} to clipboard`
          }
          className={stylex.props(styles.iconButton, motionStyles.editorMotion).className}
          title={copied ? "Copied" : "Copy to clipboard"}
          onClick={() =>
            copy(
              detail
                ? `[${source}] ${message} — ${detail}`
                : `[${source}] ${message}`,
            )
          }
        >
          {copied ? (
            <Check className={stylex.props(styles.size35).className} aria-hidden="true" />
          ) : (
            <Copy className={stylex.props(styles.size35).className} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          aria-label={`Dismiss ${message}`}
          className={stylex.props(styles.iconButton, styles.iconButtonEdge, motionStyles.editorMotion).className}
          onClick={() => onDismiss(keys)}
        >
          <X className={stylex.props(styles.size35).className} aria-hidden="true" />
        </button>
      </div>
      {progress != null ? (
        <div
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress}
          aria-label={`${message} progress`}
          {...stylex.props(styles.abs)}
          role="progressbar"
        >
          <span
            {...stylex.props(styles.blockTall)}
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
