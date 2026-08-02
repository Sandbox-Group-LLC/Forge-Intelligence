import * as React from "react";

/** Section kicker: 11px uppercase, 0.14em tracking, optional accent rule. */
export interface EyebrowProps extends React.HTMLAttributes<HTMLSpanElement> {
  children?: React.ReactNode;
  tone?: "default" | "accent" | "positive";
  rule?: boolean;
}
export declare function Eyebrow(props: EyebrowProps): JSX.Element;
