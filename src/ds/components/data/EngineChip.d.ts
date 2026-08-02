import * as React from "react";

/** The answer engines Forge measures against. */
export declare const ENGINES: string[];

/**
 * One engine's standing for a brand or topic.
 */
export interface EngineChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Engine name, e.g. "ChatGPT" | "Perplexity" | "Gemini" | "AI Overviews" | "Claude". */
  engine: string;
  value?: number;
  unit?: string;
  /** cited = teal (we win it), contested = amber (shared), absent = grey (we are not there). */
  state?: "cited" | "contested" | "absent";
}
export declare function EngineChip(props: EngineChipProps): JSX.Element;

export interface EngineChipRowProps extends React.HTMLAttributes<HTMLDivElement> {
  items: EngineChipProps[];
}
export declare function EngineChipRow(props: EngineChipRowProps): JSX.Element;
