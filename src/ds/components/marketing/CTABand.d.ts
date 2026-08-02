import * as React from "react";

/**
 * Closing conversion panel: gradient border, blue glow, teal-washed corner.
 */
export interface CTABandProps extends React.HTMLAttributes<HTMLDivElement> {
  eyebrow?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  note?: React.ReactNode;
}
export declare function CTABand(props: CTABandProps): JSX.Element;
