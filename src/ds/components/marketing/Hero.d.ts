import * as React from "react";

/**
 * Page-opening hero: beam, 48px grid, oversized display title, CTA row, proof strip.
 * Wrap an accent phrase in <em> inside title to get the blue→teal gradient text.
 */
export interface HeroProps extends React.HTMLAttributes<HTMLElement> {
  eyebrow?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Button row. */
  actions?: React.ReactNode;
  /** Chips, engine standings or logos under the CTAs. */
  proof?: React.ReactNode;
  /** Product frame or data panel below the copy. */
  visual?: React.ReactNode;
  align?: "center" | "left";
  grid?: boolean;
  beam?: boolean;
}
export declare function Hero(props: HeroProps): JSX.Element;
