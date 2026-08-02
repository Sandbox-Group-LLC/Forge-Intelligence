import * as React from "react";

/** Square icon-only control for chrome: nav toggles, dismiss, overflow. */
export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string;
  /** Required — becomes aria-label and title. */
  label: string;
  size?: "sm" | "md";
  variant?: "default" | "ghost";
}
export declare function IconButton(props: IconButtonProps): JSX.Element;
