"use client";

import { useEffect, useState } from "react";
import { applyTheme, currentTheme, THEME_EVENT, type Theme } from "@/lib/theme";

/** Header switch between light (default) and dark mode; the choice is saved in this browser. */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    setTheme(currentTheme());
    const sync = () => setTheme(currentTheme());
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);
  const dark = theme === "dark";
  return (
    <button type="button" className="theme-toggle" aria-pressed={dark} aria-label="Dark mode" title={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => applyTheme(dark ? "light" : "dark")}>
      {dark ? (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.7" /><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>
      )}
    </button>
  );
}
