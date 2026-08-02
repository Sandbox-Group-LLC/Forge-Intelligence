import * as React from "react";

/** Small status / category label. Uppercase micro type by default. */
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  children?: React.ReactNode;
  tone?: "neutral" | "accent" | "positive" | "warn" | "danger" | "solid";
  /** lg switches to 13px sentence case — use for pricing ribbons. */
  size?: "sm" | "lg";
  dot?: boolean;
  /** Pulsing dot for live/streaming state. */
  live?: boolean;
}
export declare function Badge(props: BadgeProps): JSX.Element;
