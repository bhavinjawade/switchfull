import { spawn } from "node:child_process";

/** Open a URL in the user’s default browser (best-effort, non-blocking). */
export function openUrl(url: string): { ok: boolean; message: string } {
  if (!/^https?:\/\//iu.test(url)) {
    return { ok: false, message: `Not an http(s) URL: ${url}` };
  }
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return { ok: true, message: `Opened ${url}` };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
