import React from "react";
import { Logo } from "../brand/Logo.jsx";

export function Footer({
  blurb = "The intelligence layer your marketing operation never had.",
  columns = [],
  legal = [],
  copyright,
  className = "",
  ...rest
}) {
  const year = new Date().getFullYear();
  return (
    <footer className={["fi-footer", className].filter(Boolean).join(" ")} {...rest}>
      <div className="fi-footer__inner">
        <div className="fi-footer__top">
          <div>
            <Logo href="#" size={22} />
            <p className="fi-footer__blurb">{blurb}</p>
          </div>
          {columns.map((col) => (
            <div key={col.title}>
              <div className="fi-footer__coltitle">{col.title}</div>
              <ul className="fi-footer__list">
                {col.links.map((l) => (
                  <li key={l.label}><a className="fi-footer__link" href={l.href}>{l.label}</a></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="fi-footer__rule" />
        <div className="fi-footer__bottom">
          <span>{copyright || "© " + year + " Forge Intelligence"}</span>
          <span className="fi-footer__legal">
            {legal.map((l) => <a key={l.label} href={l.href}>{l.label}</a>)}
          </span>
        </div>
      </div>
    </footer>
  );
}
