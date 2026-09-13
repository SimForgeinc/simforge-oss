"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
import { styles } from "./tabs.stylex";

const Tabs = TabsPrimitive.Root;

/**
 * Caller-supplied StyleX styles, applied after the primitive's own so the
 * caller wins per property. A `className` cannot do that job here: the active
 * rules below are attribute conditions, which StyleX compiles at a specificity
 * no plain class reaches.
 *
 * Typed as what `stylex.props` accepts — a compiled StyleX namespace — rather
 * than as `StyleXStyles`. The callers that need this seam key their rules on
 * `[data-state=...]`, and StyleX's value-checked style type only models
 * `:pseudo` and `@at-rule` conditions: an attribute condition falls off the
 * end of its `ComplexStyleValueType` and compiles to
 * `StyleXClassNameFor<K, unknown>`, which no declared CSS value type accepts.
 * Compiled class names stay opaque either way, so a plain object, a string or
 * a `className` is still rejected here.
 */
type TabsStyle = stylex.StyleXArray<
  | null
  | undefined
  | false
  | stylex.CompiledStyles
  | Readonly<[stylex.CompiledStyles, stylex.InlineStyles]>
>;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { xstyle?: TabsStyle }
>(({ className, xstyle, ...props }, ref) => (
  <TabsPrimitive.List ref={ref} {...mergeStyleProps(stylex.props(styles.list, xstyle), className)} {...props} />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & { xstyle?: TabsStyle }
>(({ className, xstyle, ...props }, ref) => (
  <TabsPrimitive.Trigger ref={ref} {...mergeStyleProps(stylex.props(styles.trigger, xstyle), className)} {...props} />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content> & { xstyle?: TabsStyle }
>(({ className, xstyle, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} {...mergeStyleProps(stylex.props(styles.content, xstyle), className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
