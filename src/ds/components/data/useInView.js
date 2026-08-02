import React from "react";

/**
 * Fires once when the element scrolls into view. Shared by count-ups, meters and reveals.
 * Resolves immediately in a hidden document and falls back on a timer, so offscreen
 * captures (design-system thumbnails, print, prerender) still render final values.
 */
export function useInView(options) {
  const ref = React.useRef(null);
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setShown(true); return; }
    if (typeof document !== "undefined" && document.visibilityState === "hidden") { setShown(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setShown(true); io.disconnect(); }
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.15, ...(options || {}) });
    io.observe(el);
    const fallback = setTimeout(() => { setShown(true); io.disconnect(); }, 600);
    return () => { clearTimeout(fallback); io.disconnect(); };
  }, [shown, options]);
  return [ref, shown];
}
