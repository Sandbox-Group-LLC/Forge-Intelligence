import React from "react";

export function ScreenFrame({ children, url, chrome = true, label, className = "", style, ...rest }) {
  return (
    <div className={["fi-frame", className].filter(Boolean).join(" ")} style={style} {...rest}>
      {chrome && (
        <div className="fi-frame__chrome">
          <span className="fi-frame__dots"><i className="fi-frame__dot" /><i className="fi-frame__dot" /><i className="fi-frame__dot" /></span>
          {url && <span className="fi-frame__url">{url}</span>}
          {label && <span className="fi-frame__url" style={{ flex: "none" }}>{label}</span>}
        </div>
      )}
      <div className="fi-frame__screen">
        {children}
        <span className="fi-frame__glare" aria-hidden="true" />
      </div>
    </div>
  );
}
