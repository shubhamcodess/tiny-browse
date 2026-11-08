/**
 * The one error type the library throws. `code` is part of the public API:
 * callers switch on it, so codes are only ever added, never renamed.
 */
import { BrowserNotFoundError } from "./browser/discover.js";
import { LaunchError } from "./browser/chrome.js";
import { ConfigError } from "./config.js";
import { ToolInputError } from "./core/engine.js";
import { BlockedAddressError } from "./fetch/guard.js";
import { SearchUnavailableError } from "./search/search.js";

export type TinyBrowseErrorCode =
  /** No usable Chrome/Chromium/Edge/Brave (or it would not start). */
  | "chrome_not_found"
  /** The call ran out of time (`timeoutMs`). */
  | "timeout"
  /** A site or every search engine refused (CAPTCHA, bot check, rate budget). */
  | "blocked"
  /** DNS, connection, HTTP or other network failure. */
  | "network"
  /** The URL points at this computer or a private network. */
  | "private_address"
  /** The caller's AbortSignal fired. */
  | "aborted"
  /** The input or options are not valid; the message says how to fix them. */
  | "invalid_input";

export class TinyBrowseError extends Error {
  override name = "TinyBrowseError";
  constructor(
    readonly code: TinyBrowseErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Code for a per-page failure message produced by the readers. */
export function codeForMessage(message: string): TinyBrowseErrorCode {
  if (/local or private network address|only http\(s\) URLs/i.test(message)) return "private_address";
  if (/no chrome|chromium|browser\.path|chrome exited|chrome did not start|chrome is turned off/i.test(message)) return "chrome_not_found";
  if (/bot check|captcha|rate budget|consent page/i.test(message)) return "blocked";
  if (/timed out|timeout|not received within|no reply within/i.test(message)) return "timeout";
  return "network";
}

/** Turn anything thrown inside the engine into a TinyBrowseError. */
export function toTinyBrowseError(err: unknown, ctx: { aborted?: boolean; timedOut?: boolean } = {}): TinyBrowseError {
  if (err instanceof TinyBrowseError) return err;
  if (ctx.aborted) return new TinyBrowseError("aborted", "the call was aborted", { cause: err });
  if (ctx.timedOut) return new TinyBrowseError("timeout", "the call timed out", { cause: err });
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof BrowserNotFoundError || err instanceof LaunchError) return new TinyBrowseError("chrome_not_found", message, { cause: err });
  if (err instanceof BlockedAddressError) return new TinyBrowseError("private_address", message, { cause: err });
  if (err instanceof ToolInputError || err instanceof ConfigError) return new TinyBrowseError("invalid_input", message, { cause: err });
  if (err instanceof SearchUnavailableError) {
    const notes = err.attempts.map((a) => `${a.status} ${a.note ?? ""}`).join(" | ");
    const errorsOnly = err.attempts.every((a) => a.status === "error" || (a.status === "skipped" && /needs chrome/i.test(a.note ?? "")));
    if (errorsOnly && codeForMessage(notes) === "chrome_not_found") return new TinyBrowseError("chrome_not_found", message, { cause: err });
    if (err.attempts.some((a) => a.status === "challenge" || a.status === "consent" || a.status === "skipped" || a.status === "off_topic")) {
      return new TinyBrowseError("blocked", message, { cause: err });
    }
    return new TinyBrowseError("network", message, { cause: err });
  }
  if ((err as Error)?.name === "AbortError") return new TinyBrowseError("aborted", message, { cause: err });
  return new TinyBrowseError(codeForMessage(message), message, { cause: err });
}
