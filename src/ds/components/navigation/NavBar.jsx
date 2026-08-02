import React from "react";
import { Logo } from "../brand/Logo.jsx";
import { Button } from "../core/Button.jsx";
import { IconButton } from "../core/IconButton.jsx";

export function NavBar({
  links = [],
  activeHref,
  onNavigate,
  ctaLabel = "Book a walkthrough",
  onCta,
  secondaryLabel = "Sign in",
  onSecondary,
  sticky = true,
  className = "",
  ...rest
}) {
  const [scrolled, setScrolled] = React.useState(false);
  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={["fi-nav", scrolled ? "fi-nav--scrolled" : "", className].filter(Boolean).join(" ")}
      style={sticky ? undefined : { position: "relative" }}
      {...rest}
    >
      <div className="fi-nav__inner">
        <Logo href="#" size={22} onClick={(e) => { e.preventDefault(); onNavigate && onNavigate("/"); }} />
        <nav className="fi-nav__links" aria-label="Primary">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className={["fi-nav__link", l.href === activeHref ? "fi-nav__link--active" : ""].filter(Boolean).join(" ")}
              onClick={(e) => { if (onNavigate) { e.preventDefault(); onNavigate(l.href); } }}
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="fi-nav__actions">
          {secondaryLabel && <Button variant="tertiary" size="sm" onClick={onSecondary}>{secondaryLabel}</Button>}
          {ctaLabel && <Button variant="primary" size="sm" onClick={onCta}>{ctaLabel}</Button>}
          <span className="fi-nav__toggle"><IconButton icon="menu" label="Open menu" size="sm" variant="ghost" /></span>
        </div>
      </div>
    </header>
  );
}
