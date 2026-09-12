import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
import { styles } from "./card.stylex";

type CardStyle = stylex.StyleXStyles;
type CardProps = React.HTMLAttributes<HTMLDivElement> & { xstyle?: CardStyle };

const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, style, xstyle, ...props }, ref) => (
  <div ref={ref} {...props} {...mergeStyleProps(stylex.props(styles.card, xstyle), className, style)} />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, CardProps>(({ className, style, xstyle, ...props }, ref) => (
  <div ref={ref} {...props} {...mergeStyleProps(stylex.props(styles.header, xstyle), className, style)} />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLDivElement, CardProps>(({ className, style, xstyle, ...props }, ref) => (
  <div ref={ref} {...props} {...mergeStyleProps(stylex.props(styles.title, xstyle), className, style)} />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLDivElement, CardProps>(({ className, style, xstyle, ...props }, ref) => (
  <div ref={ref} {...props} {...mergeStyleProps(stylex.props(styles.description, xstyle), className, style)} />
));
CardDescription.displayName = "CardDescription";

const CardAction = React.forwardRef<HTMLDivElement, CardProps>(({ className, style, xstyle, ...props }, ref) => (
  <div ref={ref} {...props} {...mergeStyleProps(stylex.props(styles.action, xstyle), className, style)} />
));
CardAction.displayName = "CardAction";

const CardContent = React.forwardRef<HTMLDivElement, CardProps>(({ className, style, xstyle, ...props }, ref) => (
  <div ref={ref} {...props} {...mergeStyleProps(stylex.props(styles.content, xstyle), className, style)} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, CardProps>(({ className, style, xstyle, ...props }, ref) => (
  <div ref={ref} {...props} {...mergeStyleProps(stylex.props(styles.footer, xstyle), className, style)} />
));
CardFooter.displayName = "CardFooter";

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
