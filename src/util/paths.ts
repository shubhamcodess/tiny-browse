import { homedir } from "node:os";
import { join } from "node:path";

const APP = "tiny-browse";

type Env = Record<string, string | undefined>;

/** Directory for the user config file (`config.json`). */
export function configDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, APP);
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, APP);
  return join(homedir(), ".config", APP);
}

/** Directory for caches and the dedicated Chrome profile. */
export function cacheDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, APP);
  if (platform === "darwin") return join(homedir(), "Library", "Caches", APP);
  if (platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, APP, "Cache");
  return join(homedir(), ".cache", APP);
}
