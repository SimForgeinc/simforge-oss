"use client";

import Link from "next/link";
import * as stylex from "@stylexjs/stylex";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { AppSwitcherArt } from "@/app/components/AppSwitcherArt";
import { RenderSettingsSurface } from "@/app/host";
import { SwitcherAccount } from "@/app/components/SwitcherAccount";
import { useDashboardNav, type NavItem, type SwitcherInlineView } from "@/app/lib/dashboard-nav";
import { styles } from "@/app/components/AppSwitcherOverlay.stylex";

/**
 * The switcher's one screen: the product tabs — Maps, Datasets, Evaluation —
 * as three equal cards, each an artwork stage over its words, and beneath
 * them one bar holding the utilities and the workspace and account.
 * Rendered by the top-bar overlay and, as the place a sign-in lands, by
 * `/dashboard/apps`: choosing what to do costs nothing, whereas landing inside
 * an app means waiting for a map.
 *
 * A utility marked `inlineView` (Render Settings) does not navigate: the tabs
 * are replaced by that view in the same column, with a way back. `/dashboard/
 * apps?view=render-settings` opens the page already on it.
 */
export function AppSwitcherPanel({
  pathname,
  initialView = null,
  onNavigate,
}: {
  pathname: string;
  initialView?: SwitcherInlineView | null;
  /** Called when a tab or utility is chosen; the overlay closes itself here. */
  onNavigate: () => void;
}) {
  const { apps, utilities, accountItems, capabilities } = useDashboardNav(pathname);
  const [view, setView] = useState<SwitcherInlineView | null>(initialView);
  useEffect(() => setView(initialView), [initialView]);

  return (
    <div {...stylex.props(styles.container)}>
      {view === "render-settings" ? (
        <section {...stylex.props(styles.inlineView)} aria-label="Render Settings" data-testid="app-switcher-inline-view" data-view={view}>
          <div {...stylex.props(styles.inlineHead)}>
            <button {...stylex.props(styles.inlineBack)} type="button" onClick={() => setView(null)}>
              <ArrowLeft {...stylex.props(styles.inlineBackIcon)} aria-hidden="true" />
              All apps
            </button>
            <button {...stylex.props(styles.inlineBack)} type="button" onClick={() => setView(null)}>
              Done
            </button>
          </div>
          <RenderSettingsSurface onDone={() => setView(null)} />
        </section>
      ) : (
        <nav
          {...stylex.props(styles.tabs)}
          aria-label="SimForge apps"
          data-testid="app-switcher-tabs"
        >
          {apps.map((app) => (
            <AppTab
              active={!app.disabled && app.match(pathname)}
              app={app}
              key={app.href}
              onOpen={onNavigate}
            />
          ))}
        </nav>
      )}

      <div {...stylex.props(styles.footer)} data-testid="app-switcher-footer">
        <nav aria-label="App utilities" {...stylex.props(styles.utilities)}>
          {utilities.map((item) => (
            <UtilityLink
              active={item.inlineView ? view === item.inlineView : item.match(pathname)}
              item={item}
              key={item.href}
              onOpen={onNavigate}
              onInline={setView}
            />
          ))}
        </nav>
        <div {...stylex.props(styles.footerAside)}>
          <SwitcherAccount accountItems={accountItems} capabilities={capabilities} onNavigate={onNavigate} />
        </div>
      </div>
    </div>
  );
}

function AppTab({
  active,
  app,
  onOpen,
}: {
  active: boolean;
  app: NavItem;
  onOpen: () => void;
}) {
  const Icon = app.icon;
  const content = (
    <>
      <span {...stylex.props(styles.art, active && styles.artStageActive)}>
        <span {...stylex.props(styles.artFrame, app.disabled ? styles.artDisabled : active ? styles.artActive : styles.artIdle)}>
          <AppSwitcherArt href={app.href} />
        </span>
      </span>
      <span {...stylex.props(styles.tabBody)}>
        <span {...stylex.props(styles.tabHead)}>
          <Icon
            {...stylex.props(styles.tabIcon, active && styles.tabIconActive)}
            aria-hidden="true"
          />
          <span
            {...stylex.props(styles.tabTitle, active ? styles.tabTitleActive : styles.tabTitleIdle)}
          >
            {app.label}
          </span>
        </span>
        <span {...stylex.props(styles.tabDescription)}>{app.description}</span>
        {app.highlights !== undefined ? (
          <span {...stylex.props(styles.tabHighlights)}>
            {app.highlights.map((highlight) => (
              <span key={highlight} {...stylex.props(styles.tabHighlight)}>
                {highlight}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </>
  );
  // The marker lets the artwork answer the card's hover and focus.
  const tabProps = stylex.props(
    styles.tab,
    app.disabled ? styles.tabDisabled : active ? styles.tabActive : styles.tabIdle,
    stylex.defaultMarker(),
  );

  return app.disabled ? (
    <button
      aria-label={`${app.label} — Coming soon`}
      {...tabProps}
      data-app={app.label}
      data-visual-treatment="disabled"
      disabled
      type="button"
    >
      {content}
    </button>
  ) : (
    <Link
      aria-current={active ? "page" : undefined}
      {...tabProps}
      data-app={app.label}
      data-visual-treatment="open"
      href={app.href}
      onClick={onOpen}
    >
      {content}
    </Link>
  );
}

function UtilityLink({
  active,
  item,
  onOpen,
  onInline,
}: {
  active: boolean;
  item: NavItem;
  onOpen: () => void;
  onInline: (view: SwitcherInlineView) => void;
}) {
  const Icon = item.icon;
  const utilityProps = stylex.props(styles.utility, active ? styles.utilityActive : styles.utilityIdle);
  if (item.inlineView) {
    const view = item.inlineView;
    return (
      <button aria-pressed={active} {...utilityProps} type="button" onClick={() => onInline(view)}>
        <Icon {...stylex.props(styles.utilityIcon)} aria-hidden="true" />
        <span>{item.label}</span>
      </button>
    );
  }
  return (
    <Link aria-current={active ? "page" : undefined} {...utilityProps} href={item.href} onClick={onOpen}>
      <Icon {...stylex.props(styles.utilityIcon)} aria-hidden="true" />
      <span>{item.label}</span>
    </Link>
  );
}
