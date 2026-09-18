"use client";

import * as stylex from "@stylexjs/stylex";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ActorRenderer, CityViewer } from "@simforge-oss/viewer";
import { ScenarioWorldHost, type ScenarioWorldState } from "./ScenarioWorldHost";

const styles = stylex.create({
  viewport: { position: "absolute", inset: 0, width: "100%", height: "100%" },
  hidden: { opacity: 0, pointerEvents: "none" },
});

type SurfaceProps = ComponentProps<typeof ScenarioWorldHost>;
type Lease = { element: HTMLDivElement; props: () => SurfaceProps };
type WorldContext = {
  claim: (lease: Lease) => () => void;
  update: (lease: Lease) => void;
};
const Context = createContext<WorldContext | null>(null);
const EMPTY_STATE: ScenarioWorldState = { target: null, loadedMapVersionId: null, streaming: false, error: null };

/**
 * Dashboard lifetime, page viewport. The portal container never changes identity;
 * only its parent changes. Portalling directly into a route's div would remount
 * CityView when that div changes and allocate another WebGL context.
 *
 * keepAlive is a host routing decision, not a timeout: retain the current map
 * while another world surface resolves, release it when visiting a non-world page.
 * Nothing is constructed until a mounted surface publishes its first target.
 */
export function ScenarioWorldProvider({ children, keepAlive = false }: { children: ReactNode; keepAlive?: boolean }) {
  const [container] = useState(() => typeof document === "undefined" ? null : document.createElement("div"));
  const [request, setRequest] = useState<SurfaceProps | null>(null);
  const [attached, setAttached] = useState(false);
  const leaseRef = useRef<Lease | null>(null);
  const viewerRef = useRef<CityViewer | null>(null);
  const actorsRef = useRef<ActorRenderer | null>(null);
  const stateRef = useRef<ScenarioWorldState>(EMPTY_STATE);

  const publish = useCallback(() => {
    const lease = leaseRef.current;
    if (!lease) return;
    const props = lease.props();
    const state = stateRef.current;
    // Readiness belongs to the destination's declared identity, never the
    // previously painted map while its record is still resolving.
    const matches = props.target?.mapVersionId === state.loadedMapVersionId;
    if (container) container.className = stylex.props(styles.viewport, !matches && styles.hidden).className ?? "";
    props.onViewerChange(viewerRef.current);
    props.onActorRendererChange(actorsRef.current);
    props.onStateChange(matches ? state : { ...state, target: props.target, loadedMapVersionId: null });
  }, [container]);

  const update = useCallback((lease: Lease) => {
    if (leaseRef.current !== lease) return;
    setRequest(lease.props());
    publish();
  }, [publish]);

  const claim = useCallback((lease: Lease) => {
    leaseRef.current = lease;
    if (container) lease.element.appendChild(container);
    viewerRef.current?.setRenderingSuspended(false);
    setAttached(true);
    update(lease);
    return () => {
      // A late outgoing-page cleanup cannot detach the incoming page's lease.
      if (leaseRef.current !== lease) return;
      leaseRef.current = null;
      container?.remove();
      viewerRef.current?.setRenderingSuspended(true);
      setAttached(false);
    };
  }, [container, update]);

  const onViewerChange = useCallback((viewer: CityViewer | null) => {
    viewerRef.current = viewer;
    if (!viewer) stateRef.current = EMPTY_STATE;
    publish();
  }, [publish]);
  const onActorRendererChange = useCallback((actors: ActorRenderer | null) => {
    actorsRef.current = actors;
    publish();
  }, [publish]);
  const onStateChange = useCallback((state: ScenarioWorldState) => {
    stateRef.current = state;
    publish();
  }, [publish]);
  const context = useMemo(() => ({ claim, update }), [claim, update]);
  const mounted = attached || keepAlive;

  useLayoutEffect(() => {
    // Forget the old page's callbacks as well as its GPU resources. A later
    // world route must not resurrect this released target before it declares one.
    if (!mounted && !leaseRef.current) setRequest(null);
  }, [mounted]);

  return (
    <Context.Provider value={context}>
      {container && request && mounted ? createPortal(
        <ScenarioWorldHost
          target={request.target}
          pendingTarget={request.pendingTarget}
          interactive={attached && Boolean(request.target) && request.interactive !== false}
          className={stylex.props(styles.viewport).className}
          onViewerChange={onViewerChange}
          onActorRendererChange={onActorRendererChange}
          onStateChange={onStateChange}
        />,
        container,
      ) : null}
      {children}
    </Context.Provider>
  );
}

/** A page declares its target and geometry; it never owns a renderer. */
export function ScenarioWorldSurface(props: SurfaceProps) {
  const context = useContext(Context);
  if (!context) throw new Error("ScenarioWorldSurface requires ScenarioWorldProvider above the route boundary");
  const elementRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const leaseRef = useRef<Lease | null>(null);
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const lease = { element, props: () => propsRef.current };
    leaseRef.current = lease;
    return context.claim(lease);
  }, [context]);
  useLayoutEffect(() => {
    if (leaseRef.current) context.update(leaseRef.current);
  }, [context, props.target, props.pendingTarget, props.interactive]);
  return <div ref={elementRef} className={props.className} data-testid="scenario-world-surface" />;
}
