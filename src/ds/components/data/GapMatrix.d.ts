import * as React from "react";

export interface GapCell {
  state?: "owned" | "partial" | "contested" | "gap" | "empty";
  /** Optional number rendered inside the cell. */
  value?: number | string;
}
export interface GapRow {
  label: string;
  cells: GapCell[];
}

/**
 * Topic × engine coverage grid. The empty cells are the product pitch.
 * @startingPoint section="Data" subtitle="Topic × engine whitespace grid" viewport="700x320"
 */
export interface GapMatrixProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Column headers — usually engine names. */
  columns: string[];
  rows: GapRow[];
  legend?: boolean;
  /** Width of the row-label column in px. */
  rowWidth?: number;
}
export declare function GapMatrix(props: GapMatrixProps): JSX.Element;
