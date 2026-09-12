"use client";

import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { ArrowRight, Monitor } from "lucide-react";
import { mergeStyleProps } from "../../components/stylex/surface";
import { Button } from "../../components/ui/button";
import { styles as s } from "./evaluation-components.stylex";

export function DesktopRequiredNotice({ capability, description, bullets = [], downloadHref = "/download", downloadLabel = "Get the desktop app", secondaryAction, className }: {
  capability: string; description: string; bullets?: readonly string[]; downloadHref?: string; downloadLabel?: string; secondaryAction?: ReactNode; className?: string;
}) {
  return <section {...mergeStyleProps(stylex.props(s.max2xl, s.section5, s.border, s.mutedSurface, s.p8), className)} data-testid="desktop-required-notice">
    <span {...stylex.props(s.rowTight, s.border, s.px3py2, s.textXs, s.fontMedium, s.uppercaseWide, s.textMuted)}><Monitor aria-hidden="true" {...stylex.props(s.iconSm)} />Desktop app</span>
    <div {...stylex.props(s.stack2)}><h1 {...stylex.props(s.titleLg)}>{capability} runs in the SimForge desktop app</h1><p {...stylex.props(s.textSm, s.leading6, s.textMuted)}>{description}</p></div>
    {bullets.length > 0 ? <ul {...stylex.props(s.list, s.stack1, s.textSm, s.leading6, s.textMuted)}>{bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul> : null}
    <p {...stylex.props(s.textSm, s.leading6, s.textMuted)}>The web portal keeps clip upload, cloud open-loop evaluation, results, and your account, team and billing. Everything that needs a map, a 3D viewport or native rendering is in the app — the same sign-in and the same workspace.</p>
    <div {...stylex.props(s.row)}><Button asChild><a href={downloadHref}>{downloadLabel}<ArrowRight aria-hidden="true" /></a></Button>{secondaryAction}</div>
  </section>;
}
