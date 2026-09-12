import type { ScenarioStatus } from "@simforge-oss/scenario/contracts";
import { Clock, Loader2, CheckCheck, X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import { styles } from "./ScenarioStatusBadge.stylex";

type StatusConfig = { label: string; icon: React.ReactNode; tone: keyof typeof styles };
const CONFIG: Record<ScenarioStatus, StatusConfig> = {
  DRAFT: { label: "Draft", icon: <Clock className="size-3.5" aria-hidden="true" />, tone: "draft" },
  FINALIZED: { label: "Finalized", icon: <CheckCheck className="size-3.5" aria-hidden="true" />, tone: "finalized" },
  QUEUED: { label: "Queued", icon: <Clock className="size-3.5" aria-hidden="true" />, tone: "queued" },
  RUNNING: { label: "Running", icon: <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />, tone: "running" },
  COMPLETED: { label: "Succeeded", icon: <CheckCheck className="size-3.5" aria-hidden="true" />, tone: "finalized" },
  FAILED: { label: "Failed", icon: <X className="size-3.5" aria-hidden="true" />, tone: "failed" },
} as Record<string, StatusConfig>;

interface ScenarioStatusBadgeProps { status: string }
export function ScenarioStatusBadge({ status }: ScenarioStatusBadgeProps) {
  const config = (CONFIG as Record<string, StatusConfig>)[status] ?? CONFIG.DRAFT;
  return <Badge title={config.label} aria-label={config.label} {...stylex.props(styles.base, styles[config.tone])}>{config.icon}</Badge>;
}
