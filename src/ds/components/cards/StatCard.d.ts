import * as React from "react";

/**
 * A single measured number, treated as the hero of its card.
 */
export interface StatCardProps {
  /** Uppercase micro label above the number. */
  label: string;
  value: number;
  /** Suffix rendered smaller, e.g. "%", "x", "pts". */
  unit?: string;
  /** Prefix rendered smaller, e.g. "$". */
  prefix?: string;
  caption?: string;
  /** Signed change; renders a DeltaPill. */
  delta?: number;
  deltaLabel?: string;
  decimals?: number;
  /** Count up on first view. Respects prefers-reduced-motion. */
  animate?: boolean;
  /** Blue→teal gradient rail down the left edge. */
  rail?: boolean;
  className?: string;
}
export declare function StatCard(props: StatCardProps): JSX.Element;
