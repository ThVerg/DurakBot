// Public URL prefix: "/" normally, "/DurakBot/" on GitHub Pages (VITE_BASE).
export const BASE_URL: string = import.meta.env.BASE_URL;

/** URL of a file under web/public, e.g. publicUrl("assets/ui/x.svg"). */
export function publicUrl(path: string): string {
  return BASE_URL + path.replace(/^\//, "");
}

/** Prefix for the art under web/public/assets (no trailing slash). */
export const ASSETS = publicUrl("assets");
