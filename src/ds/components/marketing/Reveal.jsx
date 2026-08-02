import React from "react";
import { useInView } from "../data/useInView.js";

export function Reveal({ children, delay = 0, as: Tag = "div", className = "", style, ...rest }) {
  const [ref, shown] = useInView();
  return (
    <Tag
      ref={ref}
      className={["fi-reveal", className].filter(Boolean).join(" ")}
      data-shown={shown ? "true" : "false"}
      style={{ transitionDelay: delay + "ms", ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
