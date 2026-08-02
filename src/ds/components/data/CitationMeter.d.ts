import * as React from "react";

/**
 * Probability / share meter — the core "measured intelligence" readout.
 */
export interface CitationMeterProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: number;
  max?: number;
  unit?: string;
  /** Draws a tick at this value with a label above it. */
  benchmark?: number;
  benchmarkLabel?: string;
  /** warn = amber fill (a gap), quiet = grey (a competitor's line). */
  tone?: "default" | "warn" | "quiet";
  footLeft?: React.ReactNode;
  footRight?: React.ReactNode;
  /** Grow from zero when scrolled into view. */
  animate?: boolean;
}
export declare function CitationMeter(props: CitationMeterProps): JSX.Element;
