/** Site colour theme. Light is the default; a buyer's choice is saved in their browser. */
export type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "loudr-theme";
export const THEME_EVENT = "loudr-theme-change";

/**
 * Runs in <head> before the page paints, so a saved dark preference never flashes light.
 * Kept as a plain string: it is inlined into the document, not bundled.
 */
export const THEME_BOOT_SCRIPT = `try{if(localStorage.getItem("${THEME_STORAGE_KEY}")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`;

export function currentTheme(): Theme {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function applyTheme(theme: Theme) {
  if (theme === "dark") document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  try { window.localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* Private mode: the choice lasts for this page only. */ }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}
