"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type RouteHeader = { title: string; context?: ReactNode; actions?: ReactNode; overflow?: ReactNode };
type Registration = { owner: string; header: RouteHeader };

type TopBarSlotContextValue = {
  header: RouteHeader | null;
  registerHeader: (owner: string, header: RouteHeader) => void;
  releaseHeader: (owner: string) => void;
  actionsAlignment: "start" | "end";
  setActionsAlignment: (alignment: "start" | "end") => void;
  actionsSlot: HTMLElement | null;
  registerActionsSlot: (el: HTMLElement | null) => void;
  trailingSlot: HTMLElement | null;
  registerTrailingSlot: (el: HTMLElement | null) => void;
};
const TopBarSlotContext = createContext<TopBarSlotContextValue | null>(null);
const HeaderPublisherContext = createContext<Pick<TopBarSlotContextValue, "registerHeader" | "releaseHeader"> | null>(null);

export function TopBarSlotProvider({ children }: { children: ReactNode }) {
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [actionsAlignment, setActionsAlignment] = useState<"start" | "end">("end");
  const [actionsSlot, registerActionsSlot] = useState<HTMLElement | null>(null);
  const [trailingSlot, registerTrailingSlot] = useState<HTMLElement | null>(null);
  const registerHeader = useCallback((owner: string, header: RouteHeader) => {
    setRegistration(current => current?.owner === owner && current.header.title === header.title && current.header.context === header.context && current.header.actions === header.actions && current.header.overflow === header.overflow ? current : { owner, header });
  }, []);
  const releaseHeader = useCallback((owner: string) => setRegistration(current => current?.owner === owner ? null : current), []);
  const publisher = useMemo(() => ({ registerHeader, releaseHeader }), [registerHeader, releaseHeader]);
  return <HeaderPublisherContext.Provider value={publisher}><TopBarSlotContext.Provider value={{ header: registration?.header ?? null, registerHeader, releaseHeader, actionsAlignment, setActionsAlignment, actionsSlot, registerActionsSlot, trailingSlot, registerTrailingSlot }}>{children}</TopBarSlotContext.Provider></HeaderPublisherContext.Provider>;
}
export function useTopBarSlotContext() { return useContext(TopBarSlotContext); }

/** Updates never release ownership; only unmount releases this owner's registration. */
export function useRouteHeader(header: RouteHeader) {
  const owner = useId();
  const ctx = useContext(HeaderPublisherContext);
  const register = ctx?.registerHeader;
  const release = ctx?.releaseHeader;
  useEffect(() => { register?.(owner, header); }, [header.title, header.context, header.actions, header.overflow, owner, register]);
  useEffect(() => () => { release?.(owner); }, [owner, release]);
}

/** Legacy title-only declarations retained for world/drive integrations outside the shell cutover. */
export function useSetPageTitle(title: string | null | undefined) { useRouteHeader({ title: title?.trim() ?? "" }); }
export function useSetTopBarActionsAlignment(alignment: "start" | "end") {
  const set = useContext(TopBarSlotContext)?.setActionsAlignment;
  useEffect(() => { set?.(alignment); return () => set?.("end"); }, [alignment, set]);
}
export function TopBarActionsPortal({ children }: { children: ReactNode }) {
  const ctx = useContext(TopBarSlotContext);
  return ctx?.actionsSlot ? createPortal(children, ctx.actionsSlot) : null;
}
export function TopBarTrailingPortal({ children }: { children: ReactNode }) {
  const ctx = useContext(TopBarSlotContext);
  return ctx?.trailingSlot ? createPortal(children, ctx.trailingSlot) : null;
}
