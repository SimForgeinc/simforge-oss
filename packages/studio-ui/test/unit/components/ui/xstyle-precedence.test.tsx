// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { Button } from "../../../../src/components/ui/button";
import { Input } from "../../../../src/components/ui/input";
import { Tabs, TabsList } from "../../../../src/components/ui/tabs";
import { button as buttonBase, buttonSizes } from "../../../../src/components/ui/controls.stylex";
import { input as inputStyles } from "../../../../src/components/ui/form-controls.stylex";
import { styles as tabsStyles } from "../../../../src/components/ui/tabs.stylex";
import { SelectMenu } from "../../../../src/components/ui/select-menu";
import { styles as selectMenuStyles } from "../../../../src/components/ui/select-menu.stylex";
import { Switch } from "../../../../src/components/ui/switch";
import { styles as switchStyles } from "../../../../src/components/ui/switch.stylex";
import { Separator } from "../../../../src/components/ui/separator";
import { separator as separatorStyles } from "../../../../src/components/ui/layout.stylex";
import { Table } from "../../../../src/components/ui/table";
import { styles as tableStyles } from "../../../../src/components/ui/table.stylex";
import { Card } from "../../../../src/components/ui/card";
import { styles as cardStyles } from "../../../../src/components/ui/card.stylex";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../../../../src/components/ui/sheet";
import { styles as sheetStyles } from "../../../../src/components/ui/sheet.stylex";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../../../src/components/ui/tooltip";
import { styles as tooltipStyles } from "../../../../src/components/ui/tooltip.stylex";
import { callerStyles } from "../../../helpers/xstyle-precedence.stylex";

/**
 * A caller's styles have to beat the primitive's own on every property they
 * share — the behaviour `twMerge` used to provide. StyleX only does that
 * inside one `props()` call, so this guards the `xstyle` seam against anyone
 * routing caller styles back through `className`, where the primitive's atom
 * would survive and win on stylesheet order instead.
 */
const atoms = (element: HTMLElement): Set<string> =>
  new Set((element.getAttribute("class") ?? "").split(" ").filter(Boolean));

const atomFor = (namespace: object, property: string): string => {
  const key = Object.keys(namespace).find((k) => k.startsWith(`${property}-`));
  if (!key) throw new Error(`no compiled ${property} atom`);
  return (namespace as Record<string, string>)[key];
};

describe("xstyle precedence", () => {
  it("lets a caller replace Button's size and base atoms", () => {
    render(<Button data-testid="button" xstyle={callerStyles.button} />);
    const classes = atoms(screen.getByTestId("button"));

    expect(classes).toContain(atomFor(callerStyles.button, "height"));
    expect(classes).toContain(atomFor(callerStyles.button, "fontSize"));
    expect(classes).not.toContain(atomFor(buttonSizes.default, "height"));
    expect(classes).not.toContain(atomFor(buttonBase.base, "fontSize"));
  });

  it("lets a caller replace Input's font size and fill", () => {
    render(<Input data-testid="input" xstyle={callerStyles.input} />);
    const classes = atoms(screen.getByTestId("input"));

    expect(classes).toContain(atomFor(callerStyles.input, "fontSize"));
    expect(classes).toContain(atomFor(callerStyles.input, "backgroundColor"));
    expect(classes).not.toContain(atomFor(inputStyles.base, "fontSize"));
    expect(classes).not.toContain(atomFor(inputStyles.base, "backgroundColor"));
  });

  it("lets a caller turn a TabsList into a grid", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList data-testid="tabs-list" xstyle={callerStyles.tabsList} />
      </Tabs>,
    );
    const classes = atoms(screen.getByTestId("tabs-list"));

    expect(classes).toContain(atomFor(callerStyles.tabsList, "display"));
    expect(classes).not.toContain(atomFor(tabsStyles.list, "display"));
  });

  it("lets a caller replace the SelectMenu trigger's height and font size", () => {
    render(
      <SelectMenu
        id="select-menu"
        label="Precision"
        value="a"
        options={["a", "b"]}
        onChange={() => {}}
        xstyle={callerStyles.selectMenu}
      />,
    );
    const classes = atoms(screen.getByRole("button", { name: "Precision" }));

    expect(classes).toContain(atomFor(callerStyles.selectMenu, "height"));
    expect(classes).toContain(atomFor(callerStyles.selectMenu, "fontSize"));
    expect(classes).not.toContain(atomFor(selectMenuStyles.trigger, "height"));
    expect(classes).not.toContain(atomFor(selectMenuStyles.trigger, "fontSize"));
  });

  it("lets a caller resize the Switch track", () => {
    render(<Switch data-testid="switch" xstyle={callerStyles.switchRoot} />);
    const classes = atoms(screen.getByTestId("switch"));

    expect(classes).toContain(atomFor(callerStyles.switchRoot, "width"));
    expect(classes).toContain(atomFor(callerStyles.switchRoot, "height"));
    expect(classes).not.toContain(atomFor(switchStyles.root, "width"));
    expect(classes).not.toContain(atomFor(switchStyles.root, "height"));
  });

  it("lets a caller thicken a horizontal Separator", () => {
    render(<Separator data-testid="separator" xstyle={callerStyles.separator} />);
    const classes = atoms(screen.getByTestId("separator"));

    expect(classes).toContain(atomFor(callerStyles.separator, "height"));
    expect(classes).not.toContain(atomFor(separatorStyles.horizontal, "height"));
  });

  it("lets a caller replace the Table's font size", () => {
    render(<Table data-testid="table" xstyle={callerStyles.table} />);
    const classes = atoms(screen.getByTestId("table"));

    expect(classes).toContain(atomFor(callerStyles.table, "fontSize"));
    expect(classes).not.toContain(atomFor(tableStyles.table, "fontSize"));
  });

  it("lets a caller replace the Card's plate colour", () => {
    render(<Card data-testid="card" xstyle={callerStyles.card} />);
    const classes = atoms(screen.getByTestId("card"));

    expect(classes).toContain(atomFor(callerStyles.card, "backgroundColor"));
    expect(classes).not.toContain(atomFor(cardStyles.card, "backgroundColor"));
  });

  it("lets a caller replace the Sheet panel's plate colour", () => {
    render(
      <Sheet open>
        <SheetContent xstyle={callerStyles.sheetContent}>
          <SheetTitle>Panel</SheetTitle>
          <SheetDescription>Panel description</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    const classes = atoms(screen.getByRole("dialog"));

    expect(classes).toContain(atomFor(callerStyles.sheetContent, "backgroundColor"));
    expect(classes).not.toContain(atomFor(sheetStyles.content, "backgroundColor"));
  });

  it("lets a caller replace the Tooltip panel's fill and font size", () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent xstyle={callerStyles.tooltipContent}>Hint</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const classes = atoms(screen.getAllByRole("tooltip")[0]);

    expect(classes).toContain(atomFor(callerStyles.tooltipContent, "backgroundColor"));
    expect(classes).toContain(atomFor(callerStyles.tooltipContent, "fontSize"));
    expect(classes).not.toContain(atomFor(tooltipStyles.content, "backgroundColor"));
    expect(classes).not.toContain(atomFor(tooltipStyles.content, "fontSize"));
  });
});
