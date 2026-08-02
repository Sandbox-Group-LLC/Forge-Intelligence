import * as React from "react";

/** Signed change chip. Positive is teal, negative is rose, zero is neutral. */
export interface DeltaPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: number;
  /** Period or qualifier, e.g. "30d". */
  label?: string;
  unit?: string;
}
export declare function DeltaPill(props: DeltaPillProps): JSX.Element;
