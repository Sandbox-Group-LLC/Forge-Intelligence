import * as React from "react";

/** Tabular number that counts up the first time it scrolls into view. */
export interface StatCounterProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: number;
  decimals?: number;
  /** Milliseconds. Defaults to --dur-count (1200). 0 disables. */
  duration?: number;
  /** Custom formatter, e.g. n => "$" + Math.round(n).toLocaleString(). */
  format?: (n: number) => string;
}
export declare function StatCounter(props: StatCounterProps): JSX.Element;
