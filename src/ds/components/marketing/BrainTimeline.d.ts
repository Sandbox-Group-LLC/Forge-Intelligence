import * as React from "react";

export interface BrainEntry {
  /** Short period label, e.g. "Week 1", "Mar". */
  when: string;
  title: string;
  note?: string;
  /** 0–100 knowledge depth; the bar that grows down the timeline. */
  depth: number;
  facts?: number;
  tag?: string;
  tone?: "neutral" | "accent" | "positive" | "warn";
  delta?: number;
  deltaUnit?: string;
}

/**
 * The brand brain compounding over time — one row per run, depth growing downward.
 * @startingPoint section="Marketing" subtitle="Brand brain compounding over time" viewport="900x520"
 */
export interface BrainTimelineProps extends React.HTMLAttributes<HTMLDivElement> {
  entries: BrainEntry[];
  animate?: boolean;
}
export declare function BrainTimeline(props: BrainTimelineProps): JSX.Element;
