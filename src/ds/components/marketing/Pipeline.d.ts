import * as React from "react";

export interface PipelineStage {
  name: string;
  /** One-line summary shown in the detail card. */
  note?: string;
  /** Longer copy; falls back to note. */
  detail?: string;
  icon?: string;
  /** Artefact badges this stage emits. */
  output?: string[];
}

/** Working stage list. Stages 3–8 are placeholders — confirm before shipping. */
export declare const PIPELINE_STAGES: PipelineStage[];

/**
 * The 8-stage pipeline, drawn as one connected system with a travelling pulse.
 * @startingPoint section="Marketing" subtitle="8-stage connected pipeline with detail card" viewport="1280x520"
 */
export interface PipelineProps extends React.HTMLAttributes<HTMLDivElement> {
  stages?: PipelineStage[];
  activeIndex?: number;
  /** Stages at or below this index render as complete (teal nodes). */
  completedThrough?: number;
  onSelect?: (index: number) => void;
  showDetail?: boolean;
  /** Travelling teal pulse along the rail. */
  pulse?: boolean;
}
export declare function Pipeline(props: PipelineProps): JSX.Element;
