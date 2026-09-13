"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
} from "lucide-react";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../../components/ui/sheet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../../components/ui/tabs";
import type { SimulationIssue } from "../simulation-issues";
import {
  buildReadinessSummary,
  READINESS_SECTIONS,
  type ReadinessItem,
  type ReadinessSection,
} from "./readiness-model";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioReadinessButton.stylex";

const SECTION_COPY: Record<
  ReadinessSection,
  { readonly title: string; readonly empty: string }
> = {
  behavior: {
    title: "Scenario behavior",
    empty: "The preview can run as authored.",
  },
  realism: {
    title: "Realism",
    empty: "No driving realism warnings found.",
  },
  export: {
    title: "Export",
    empty: "No export limitations found.",
  },
};

export function ScenarioReadinessButton({
  issues,
  onSelectIssue,
}: {
  readonly issues: readonly SimulationIssue[];
  readonly onSelectIssue?: (issue: SimulationIssue) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<ReadinessSection>("realism");
  const summary = buildReadinessSummary(issues);
  const ready = summary.status === "ready";
  const label = ready ? "Ready" : "Simulation Warnings";

  return (
    <Sheet
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setActiveSection("realism");
      }}
      open={open}
    >
      <SheetTrigger asChild>
        <Button
          aria-label={
            ready
              ? "Scenario readiness: Ready"
              : `Scenario readiness: Simulation warnings, ${summary.issueCount} ${summary.issueCount === 1 ? "item" : "items"}`
          }
          xstyle={ready ? styles.borderedGlassyGap2 : styles.borderedGlassyGap22}
          data-readiness-status={summary.status}
          data-testid="scenario-readiness-button"
          size="sm"
          title="Check scenario readiness"
          type="button"
          variant="outline"
        >
          {ready ? (
            <CheckCircle2 aria-hidden="true" className={stylex.props(styles.size4).className} />
          ) : (
            <AlertTriangle aria-hidden="true" className={stylex.props(styles.size4).className} />
          )}
          <span>{label}</span>
          {!ready ? (
            <span
              {...stylex.props(styles.mono)}
              data-testid="scenario-readiness-count"
            >
              {summary.issueCount}
            </span>
          ) : null}
        </Button>
      </SheetTrigger>

      <SheetContent
        xstyle={styles.flexColClip}
        data-testid="scenario-readiness-drawer"
        side="right"
      >
        <SheetHeader xstyle={styles.ruleB}>
          <SheetTitle>Scenario readiness</SheetTitle>
          <SheetDescription>
            {ready
              ? "The preview is ready. New concerns will appear here."
              : `${summary.issueCount} ${summary.issueCount === 1 ? "item needs" : "items need"} attention before this scenario is finished.`}
          </SheetDescription>
        </SheetHeader>

        <Tabs
          className={stylex.props(styles.flexColFill).className}
          onValueChange={(value) => setActiveSection(value as ReadinessSection)}
          value={activeSection}
        >
          <div {...stylex.props(styles.tightRuleBScrollX)}>
            <TabsList
              aria-label="Scenario readiness sections"
              xstyle={styles.gridCols3Pad1}
            >
              {READINESS_SECTIONS.map((section) => (
                <TabsTrigger
                  aria-label={summary.groups[section].length > 0
                    ? `${SECTION_COPY[section].title}, ${summary.groups[section].length} ${summary.groups[section].length === 1 ? "item" : "items"}`
                    : SECTION_COPY[section].title}
                  xstyle={styles.gap15}
                  key={section}
                  onClick={() => setActiveSection(section)}
                  value={section}
                >
                  {SECTION_COPY[section].title}
                  {summary.groups[section].length > 0 ? (
                    <span {...stylex.props(styles.monoMuted)}>
                      {summary.groups[section].length}
                    </span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <div {...stylex.props(styles.fillScrollYShrinkable)}>
            {READINESS_SECTIONS.map((section) => (
              <TabsContent xstyle={styles.m0} key={section} value={section}>
                <ReadinessGroup
                  items={summary.groups[section]}
                  onSelectIssue={onSelectIssue}
                  section={section}
                />
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

function ReadinessGroup({
  items,
  onSelectIssue,
  section,
}: {
  readonly items: readonly ReadinessItem[];
  readonly onSelectIssue?: (issue: SimulationIssue) => void;
  readonly section: ReadinessSection;
}) {
  const copy = SECTION_COPY[section];
  return (
    <section
      aria-labelledby={`readiness-${section}-heading`}
      {...stylex.props(styles.bordered)}
      data-testid={`scenario-readiness-${section}`}
    >
      <div {...stylex.props(styles.flexCenterBetween)}>
        <h3
          {...stylex.props(styles.xsInkSemibold)}
          id={`readiness-${section}-heading`}
        >
          {copy.title}
        </h3>
        {items.length === 0 ? (
          <CheckCircle2 aria-label="Looks good" className={stylex.props(styles.size35TextEmerald400).className} />
        ) : (
          <span {...stylex.props(styles.muted)}>
            {items.length} {items.length === 1 ? "item" : "items"}
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <p {...stylex.props(styles.xsMuted)}>{copy.empty}</p>
      ) : (
        <div>
          {items.map((item) => (
            <ReadinessIssueRow
              item={item}
              key={item.issue.id}
              onSelectIssue={onSelectIssue}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ReadinessIssueRow({
  item,
  onSelectIssue,
}: {
  readonly item: ReadinessItem;
  readonly onSelectIssue?: (issue: SimulationIssue) => void;
}) {
  const Icon = item.issue.severity === "error" ? CircleAlert : AlertTriangle;
  const content = (
    <div {...stylex.props(styles.flexStartGap25)}>
      <Icon
        aria-hidden="true"
        className={stylex.props(item.issue.severity === "error" ? styles.tightDanger : styles.tight).className}
      />
      <div {...stylex.props(styles.narrowable)}>
        <p {...stylex.props(styles.xsInkMedium)}>{item.title}</p>
        <p {...stylex.props(styles.mutedBreakWordsRelaxed)}>
          {item.detail}
        </p>
        <div {...stylex.props(styles.mt2BorderL2Border70)}>
          <p {...stylex.props(styles.capsSemibold)}>
            How to fix it
          </p>
          <p {...stylex.props(styles.breakWordsRelaxed)}>
            {item.solution}
          </p>
        </div>
      </div>
    </div>
  );

  if (onSelectIssue) {
    return (
      <button
        {...stylex.props(styles.blockWide, styles.rowDivided)}
        data-testid="scenario-readiness-issue"
        onClick={() => onSelectIssue(item.issue)}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <article
      {...stylex.props(styles.px3Py3, styles.rowDivided)}
      data-testid="scenario-readiness-issue"
      role={item.issue.severity === "error" ? "alert" : "status"}
    >
      {content}
    </article>
  );
}
