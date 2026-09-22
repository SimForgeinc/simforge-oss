// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { TopBarSlotProvider, useRouteHeader, useTopBarSlotContext } from "../src/components/TopBarSlot";
import { WorkspacePanes } from "../src/components/WorkspacePanes";
import type { CloudLoadingSurfaceProps } from "../src/components/CloudLoadingSurface";

// Removing required scope must make this directive fail type checking.
// @ts-expect-error Loading placement is mandatory.
const missingScope: CloudLoadingSurfaceProps = { title: "Loading" };
void missingScope;

afterEach(cleanup);
function Declaration({ title }: { title: string }) { useRouteHeader({ title, actions: <button>{title} action</button> }); return null; }
function Header() { const value = useTopBarSlotContext(); return <div><h1>{value?.header?.title}</h1>{value?.header?.actions}</div>; }

it("releases only the departing header owner, including StrictMode-style lifecycle handoffs", () => {
  const { rerender } = render(<TopBarSlotProvider><Declaration title="Old" /><Declaration title="New" /><Header /></TopBarSlotProvider>);
  expect(screen.getByRole("heading").textContent).toBe("New");
  rerender(<TopBarSlotProvider>{null}<Declaration title="New" /><Header /></TopBarSlotProvider>);
  expect(screen.getByRole("heading").textContent).toBe("New");
  expect(screen.getByRole("button", { name: "New action" })).toBeTruthy();
  rerender(<TopBarSlotProvider>{null}{null}<Header /></TopBarSlotProvider>);
  expect(screen.getByRole("heading").textContent).toBe("");
});

it("ignores desktop width in narrow mode and keeps pane state across switching and resizing", () => {
  let matches = true;
  let changed: (() => void) | undefined;
  vi.stubGlobal("matchMedia", () => ({ get matches() { return matches; }, addEventListener: (_: string, listener: () => void) => { changed = listener; }, removeEventListener: () => {} }));
  window.localStorage.setItem("test.workspace.width", "520");
  function Detail() { const [count, setCount] = useState(0); return <button onClick={() => setCount(count + 1)}>Count {count}</button>; }
  const { container } = render(<WorkspacePanes storageKey="test.workspace.width" rail={<input aria-label="Filter" defaultValue="retained" />} stage={<Detail />} inspector={<p>Inspector content</p>} />);
  fireEvent.click(screen.getByRole("button", { name: "Count 0" }));
  expect(container.querySelector<HTMLElement>('[data-testid="scenario-resizable-panel"]')?.style.width).toBe("520px");
  act(() => { matches = false; changed?.(); });
  expect(container.querySelector<HTMLElement>('[data-testid="scenario-resizable-panel"]')?.style.width).toBe("");
  expect(screen.queryByRole("separator")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Detail" }));
  expect(screen.getByRole("button", { name: "Count 1" }).closest("[inert]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "List" }));
  expect((screen.getByLabelText("Filter") as HTMLInputElement).value).toBe("retained");
  act(() => { matches = true; changed?.(); });
  expect(screen.getByRole("button", { name: "Count 1" })).toBeTruthy();
  expect(container.querySelector<HTMLElement>('[data-testid="scenario-resizable-panel"]')?.style.width).toBe("520px");
  vi.unstubAllGlobals();
});
