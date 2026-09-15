import type { ScenarioStatus } from "@simforge-oss/scenario/contracts";
import { Clock, Loader2, CheckCheck, X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import { styles } from "./ScenarioStatusBadge.stylex";

type StatusConfig = { label: string; icon: React.ReactNode; tone: keyof typeof styles };
const CONFIG: Record<ScenarioStatus, StatusConfig> = {
  DRAFT: { label: "Draft", icon: <Clock {...stylex.props(styles.clockIcon)} aria-hidden="true" />, tone: "draft" },
  FINALIZED: { label: "Finalized", icon: <CheckCheck {...stylex.props(styles.checkcheckIcon)} aria-hidden="true" />, tone: "finalized" },
  QUEUED: { label: "Queued", icon: <Clock {...stylex.props(styles.clockIcon2)} aria-hidden="true" />, tone: "queued" },
  RUNNING: { label: "Running", icon: <Loader2 {...stylex.props(styles.loader2Icon)} aria-hidden="true" />, tone: "running" },
  COMPLETED: { label: "Succeeded", icon: <CheckCheck {...stylex.props(styles.checkcheckIcon2)} aria-hidden="true" />, tone: "finalized" },
  FAILED: { label: "Failed", icon: <X {...stylex.props(styles.xIcon)} aria-hidden="true" />, tone: "failed" },
} as Record<string, StatusConfig>;

interface ScenarioStatusBadgeProps { status: string }
export function ScenarioStatusBadge({ status }: ScenarioStatusBadgeProps) {
  const config = (CONFIG as Record<string, StatusConfig>)[status] ?? CONFIG.DRAFT;
  return <Badge title={config.label} aria-label={config.label} xstyle={[styles.base, styles[config.tone]]}>{config.icon}</Badge>;
}
