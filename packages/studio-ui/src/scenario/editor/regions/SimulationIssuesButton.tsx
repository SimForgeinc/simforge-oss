"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CircleQuestionMark,
  Dot,
  TriangleAlert,
} from "lucide-react";
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
import * as stylex from "@stylexjs/stylex";
import { styles } from "./SimulationIssuesButton.stylex";

export function SimulationIssuesButton({
  issues,
}: {
  issues: readonly SimulationIssue[];
}) {
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const hasIssues = issues.length > 0;
  const issueState = errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "clear";
  const Icon = issueState === "error"
    ? CircleQuestionMark
    : issueState === "warning"
      ? TriangleAlert
      : Dot;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          aria-label={
            hasIssues
              ? `Simulation issues: ${errorCount} errors, ${warningCount} warnings`
              : "Simulation issues: none"
          }
          xstyle={styles.borderedGlassyGap2}
          data-error-count={errorCount}
          data-issue-state={issueState}
          data-testid="simulation-issues-button"
          data-warning-count={warningCount}
          size="sm"
          title="Open simulation errors and warnings"
          type="button"
          variant="outline"
        >
          <Icon
            aria-hidden="true"
            className={stylex.props(styles.size4, issueState === "clear" && styles.textEmerald400, issueState === "error" && styles.danger, issueState === "warning" && styles.textAmber300).className}
            data-testid={`simulation-issues-icon-${issueState}`}
          />
          <span>Simulation warnings</span>
          <span
            {...stylex.props(styles.capsMonoMuted)}
            data-testid="simulation-issues-count"
          >
            {issues.length}
          </span>
        </Button>
      </SheetTrigger>
      <SheetContent
        xstyle={styles.flexColClip}
        data-testid="simulation-issues-drawer"
        side="right"
      >
        <SheetHeader xstyle={styles.ruleB}>
          <SheetTitle>Simulation issues</SheetTitle>
          <SheetDescription>
            Errors and warnings from scenario preparation, omitted interactions,
            and browser playback.
          </SheetDescription>
        </SheetHeader>
        <div {...stylex.props(styles.fillScrollYShrinkable)}>
          {hasIssues ? (
            <Tabs defaultValue={errorCount > 0 ? "errors" : "warnings"}>
              <TabsList xstyle={styles.gridWideCols2} data-testid="simulation-issues-tabs">
                <TabsTrigger value="errors">Errors {errorCount}</TabsTrigger>
                <TabsTrigger value="warnings">Warnings {warningCount}</TabsTrigger>
              </TabsList>
              <TabsContent data-testid="simulation-errors-panel" value="errors">
                <IssueList emptyLabel="No simulation errors" issues={errors} />
              </TabsContent>
              <TabsContent data-testid="simulation-warnings-panel" value="warnings">
                <IssueList emptyLabel="No simulation warnings" issues={warnings} />
              </TabsContent>
            </Tabs>
          ) : (
            <div
              {...stylex.props(styles.gridCenteredBordered)}
              data-testid="simulation-issues-empty"
            >
              <div>
                <CheckCircle2 aria-hidden="true" className={stylex.props(styles.centeredX).className} />
                <p {...stylex.props(styles.smInkMedium)}>
                  No simulation issues
                </p>
                <p {...stylex.props(styles.xsMuted)}>
                  New playback or submission failures will appear here.
                </p>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function IssueList({
  emptyLabel,
  issues,
}: {
  emptyLabel: string;
  issues: readonly SimulationIssue[];
}) {
  if (issues.length === 0) {
    return (
      <p {...stylex.props(styles.xsMutedBordered)}>
        {emptyLabel}
      </p>
    );
  }
  return (
    <div {...stylex.props(styles.stackLg)}>
      {issues.map((issue) => {
        const IssueIcon = issue.severity === "error" ? CircleAlert : AlertTriangle;
        return (
          <article
            {...stylex.props(issue.severity === "error" ? styles.borderedPad3 : styles.borderedPad32)}
            data-severity={issue.severity}
            data-testid="simulation-issue"
            key={issue.id}
            role={issue.severity === "error" ? "alert" : "status"}
          >
            <div {...stylex.props(styles.flexStartGap25)}>
              <IssueIcon aria-hidden="true" className={stylex.props(styles.tight).className} />
              <div {...stylex.props(styles.narrowable)}>
                <p {...stylex.props(styles.smInkSemibold)}>{issue.title}</p>
                <p {...stylex.props(styles.xsMutedBreakWords)}>
                  {issue.detail}
                </p>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
