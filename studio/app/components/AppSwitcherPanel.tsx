"use client";

import Link from "next/link";
import * as stylex from "@stylexjs/stylex";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { MapDownloadIndicator } from "@simforge-oss/studio-ui/map-downloads";
import { AppSwitcherArt } from "@/app/components/AppSwitcherArt";
import { MapDownloadsSurface, RenderSettingsSurface } from "@/app/host";
import { useMapDownloadsFirstRun } from "@/app/lib/map-downloads-first-run";
import { SwitcherAccount } from "@/app/components/SwitcherAccount";
import { useDashboardNav, type NavItem, type SwitcherInlineView } from "@/app/lib/dashboard-nav";
import { styles } from "@/app/components/AppSwitcherOverlay.stylex";
import { focus, hairline, typography } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

/**
 * The switcher's one screen: the product tabs — Maps, Datasets, Evaluation —
 * as three equal cards, each an artwork stage over its words, and beneath
 * them one bar holding the utilities and the workspace and account.
 * Rendered by the top-bar overlay and, as the place a sign-in lands, by
 * `/dashboard/apps`: choosing what to do costs nothing, whereas landing inside
 * an app means waiting for a map.
 *
 * A utility marked `inlineView` (Render Settings, Map Downloads) does not
 * navigate: the tabs are replaced by that view in the same column, with a way
 * back. `/dashboard/apps?view=render-settings` (or `map-downloads`) opens the
 * page already on it.
 *
 * A person's first sign-in opens it on Map Downloads, once: the record is
 * written the moment the view is shown (`useMapDownloadsFirstRun`), by the
 * one switcher on screen (the top bar never opens its overlay on the page).
 */
export function AppSwitcherPanel({
  pathname,
  initialView = null,
  firstRun = false,
  onNavigate,
}: {
  pathname: string;
  initialView?: SwitcherInlineView | null;
  /** The caller opened the switcher for a first sign-in (the top-bar overlay does). */
  firstRun?: boolean;
  /** Called when a tab or utility is chosen; the overlay closes itself here. */
  onNavigate: () => void;
}) {
  const { apps, utilities, accountItems, capabilities } = useDashboardNav(pathname);
  const [view, setView] = useState<SwitcherInlineView | null>(initialView);
  const [welcome, setWelcome] = useState(firstRun);
  useEffect(() => setView(initialView), [initialView]);
  useEffect(() => setWelcome(firstRun), [firstRun]);
  const firstSignIn = useMapDownloadsFirstRun(capabilities);
  useEffect(() => {
    if (!firstSignIn.pending || initialView !== null || firstRun) return;
    setView("map-downloads");
    setWelcome(true);
  }, [firstSignIn.pending, initialView, firstRun]);
  // Seen once Map Downloads is on screen, whichever switcher shows it (this
  // page, or the top-bar overlay a first sign-in opened elsewhere).
  const showingMapDownloads = view === "map-downloads";
  useEffect(() => {
    if (showingMapDownloads && firstSignIn.pending) firstSignIn.markSeen();
  }, [showingMapDownloads, firstSignIn.pending, firstSignIn.markSeen]);
  const close = () => {
    setView(null);
    setWelcome(false);
  };

  return (
    <div {...stylex.props(styles.container, view === "map-downloads" && styles.containerFill)}>
      {view !== null ? (
        <section
          {...stylex.props(styles.inlineView)}
          aria-label={view === "render-settings" ? "Render Settings" : "Map Downloads"}
          data-testid="app-switcher-inline-view"
          data-view={view}
        >
          <div {...stylex.props(styles.inlineHead)}>
            <button {...stylex.props([typography.caps, focus.ring, hairline.all, styles.inlineBack])} type="button" onClick={close}>
              <ArrowLeft {...stylex.props(styles.inlineBackIcon)} aria-hidden="true" />
              All apps
            </button>
            <button {...stylex.props([typography.caps, focus.ring, hairline.all, styles.inlineBack])} type="button" onClick={close} data-testid="app-switcher-inline-done">
              {welcome ? "Not now" : "Done"}
            </button>
          </div>
          <div {...stylex.props(styles.inlineBody)}>
            {view === "render-settings" ? (
              <RenderSettingsSurface onDone={close} />
            ) : (
              <MapDownloadsSurface onDone={close} firstRun={welcome} />
            )}
          </div>
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

      <div {...stylex.props([hairline.all, styles.footer])} data-testid="app-switcher-footer">
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
        <span {...stylex.props([typography.eyebrow, styles.tabDescription])}>{app.description}</span>
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
    [focus.ring, styles.tab],
    app.disabled ? styles.tabDisabled : active ? styles.tabActive : [focus.ring, styles.tabIdle],
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
  const utilityProps = stylex.props([focus.ring, styles.utility], active ? styles.utilityActive : [focus.ringInset, styles.utilityIdle]);
  if (item.inlineView) {
    const view = item.inlineView;
    return (
      <button aria-pressed={active} {...utilityProps} type="button" onClick={() => onInline(view)} data-testid={`app-switcher-utility-${view}`}>
        <Icon {...stylex.props(styles.utilityIcon)} aria-hidden="true" />
        <span>{item.label}</span>
        {view === "map-downloads" ? <MapDownloadIndicator inline /> : null}
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
