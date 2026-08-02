import React from "react";
import { useInView } from "./useInView.js";

export function StatCounter({ value = 0, decimals = 0, duration, format, className = "", ...rest }) {
  const [ref, shown] = useInView();
  const [n, setN] = React.useState(0);

  React.useEffect(() => {
    if (!shown) return;
    const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ms = duration || 1200;
    if (reduce || ms === 0) { setN(value); return; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      setN(value * (1 - Math.pow(1 - p, 4)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // RAF is throttled or paused in hidden/offscreen documents — guarantee the final value.
    const settle = setTimeout(() => { cancelAnimationFrame(raf); setN(value); }, ms + 120);
    return () => { cancelAnimationFrame(raf); clearTimeout(settle); };
  }, [shown, value, duration]);

  const shownValue = format ? format(n) : n.toFixed(decimals);
  return <span ref={ref} className={["fi-counter", className].filter(Boolean).join(" ")} {...rest}>{shownValue}</span>;
}
