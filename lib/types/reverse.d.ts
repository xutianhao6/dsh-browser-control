/**
 * Interface-analysis and JS-reverse-engineering tools.
 *
 * These are the model-facing `browser_*` tools beyond plain automation: raw CDP
 * passthrough, cookie access (HttpOnly included), response bodies, HAR export,
 * WebSocket frames, script inventory + source extraction, sourcemap recovery,
 * breakpoints/hooking, request rewriting and replay, and a page-level
 * fetch/XHR recorder.
 *
 * Every tool here is a thin adapter over one extension command; the only logic
 * that lives on this side is (a) writing artifacts to disk, because the MV3
 * service worker cannot, and (b) assembling multi-command workflows such as
 * "dump every script" or "resolve this sourcemap", which would otherwise cost
 * the model dozens of round trips.
 * @module @caob23/dsh-browser-control/reverse
 */
import type { Context } from '@deepseek-ai/cordis';
/** The slice of the bridge controller these tools need. */
export interface ReverseToolHost {
    /** Resolved artifact directory; `undefined` until settings arrived. */
    readonly shotsDir: string | undefined;
    /** Run one extension command over the live link. */
    execute(command: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
/** Register every reverse-engineering tool. */
export declare function registerReverseTools(ctx: Context, host: ReverseToolHost): void;
