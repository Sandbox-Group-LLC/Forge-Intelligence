import * as React from "react";

/**
 * Product mount for screenshots and live UI. Gradient hairline, blue glow, glare sweep.
 */
export interface ScreenFrameProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  /** Shown in the address pill, in mono. */
  url?: string;
  chrome?: boolean;
  /** Optional right-hand pill, e.g. a status or version. */
  label?: string;
}
export declare function ScreenFrame(props: ScreenFrameProps): JSX.Element;
