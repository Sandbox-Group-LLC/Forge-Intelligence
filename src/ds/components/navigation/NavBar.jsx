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
  const [menuOpen, setMenuOpen] = React.useState(false);
  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the menu on Escape, and whenever the viewport grows back past the
  // breakpoint where the inline links return.
  React.useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setMenuOpen(false); };
    const mq = window.matchMedia("(min-width:861px)");
    const onChange = (e) => { if (e.matches) setMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    mq.addEventListener("change", onChange);
    // lock background scroll while the panel is up
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onChange);
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  const navigateAndClose = (href) => {
    setMenuOpen(false);
    if (onNavigate) onNavigate(href);
  };

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
          <span className="fi-nav__toggle">
            <IconButton
              icon={menuOpen ? "x" : "menu"}
              label={menuOpen ? "Close menu" : "Open menu"}
              size="sm"
              variant="ghost"
              aria-expanded={menuOpen}
              aria-controls="fi-nav-menu"
              onClick={() => setMenuOpen((v) => !v)}
            />
          </span>
        </div>
      </div>

      {menuOpen && (
        <nav id="fi-nav-menu" className="fi-nav__panel" aria-label="Mobile">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className={["fi-nav__link", l.href === activeHref ? "fi-nav__link--active" : ""].filter(Boolean).join(" ")}
              onClick={(e) => { if (onNavigate) { e.preventDefault(); navigateAndClose(l.href); } else setMenuOpen(false); }}
            >
              {l.label}
            </a>
          ))}
          <div className="fi-nav__panelactions">
            {ctaLabel && (
              <Button variant="primary" size="md" onClick={() => { setMenuOpen(false); onCta && onCta(); }}>
                {ctaLabel}
              </Button>
            )}
            {secondaryLabel && (
              <Button variant="secondary" size="md" onClick={() => { setMenuOpen(false); onSecondary && onSecondary(); }}>
                {secondaryLabel}
              </Button>
            )}
          </div>
        </nav>
      )}
    </header>
  );
}
