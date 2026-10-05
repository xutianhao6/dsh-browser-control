/**
 * Browser-bridge plugin: one local WebSocket endpoint the DSH Browser Control
 * extension connects to, plus the model-facing `browser_*` tools that drive it.
 *
 * The `enabled` flag starts and stops the listener with no reload, across two
 * generations of dsh:
 *
 * - **0.2.x** — `ctx.settings` is the `SettingsForms` service (the schema-derived
 *   configuration UI). It exposes no per-plugin registry: the Loader re-applies
 *   this plugin whenever its entry config changes, so converging the listener on
 *   the `apply` argument *is* the live path, and the settings page is generated
 *   from the `Config` schema below.
 * - **0.1.x** — `ctx.settings.register` owned a per-plugin section and returned a
 *   watchable scope. Still used when present (feature-detected at runtime),
 *   because this same build is linked into 0.1.x profiles.
 *
 * Tools stay mounted whenever the plugin does; calling one while the bridge
 * is disabled or the extension is offline fails with a message naming the
 * fix, so the model can tell the user what to do instead of hanging.
 * @module @deepseek-ai/dsh-browser-bridge
 */
import { type Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/**
 * A JSON value, as the runtime defines it: `dsh-util-values`' `JsonValue`, which
 * dsh-tools re-exported through 0.1.x and stopped re-exporting in 0.2.0. Declared
 * here rather than imported so one build serves both generations — the plugin's
 * own value types are structural, and a type-only import of the implementation
 * package would add a dependency the plugin otherwise does not have.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "browser-bridge";
/** The tool registry this plugin contributes `browser_*` tools to. */
export declare const inject: string[];
/** Settings namespace carrying the bridge switch and endpoint options. */
export declare const BROWSER_BRIDGE_SETTINGS_NAMESPACE = "browser-bridge";
export interface Config {
    /**
     * Whether the local bridge listens. Defaults to true so the plugin is
     * usable immediately after install; set false to keep the tools mounted but
     * every call reports how to enable the bridge, so the opt-out stays explicit.
     */
    enabled?: boolean;
    /** Loopback port the extension dials; the HTTP face shares it. */
    port?: number;
    /** Shared secret the extension presents on the WebSocket upgrade query. */
    token?: string;
    /**
     * Directory screenshots are written to and `cleanup` clears. Relative paths
     * resolve against the process working directory at resolve time.
     */ shotsDir?: string;
    /**
     * Dedicated browser environment. When enabled, a `browser_*` call that finds
     * no extension link launches this user-data-dir first — that is what keeps
     * dsh's debugger out of a daily profile shared with other extensions that
     * also request `debugger` (Chrome allows one client per tab).
     */
    launch?: LaunchConfig;
}
/**
 * Settings for the dedicated browser environment the bridge drives. Empty by
 * default: without `enabled` plus a `profileDir` nothing is ever spawned, so an
 * existing single-profile setup keeps behaving exactly as before.
 */
export interface LaunchConfig {
    /** Bring the dedicated browser up when no extension is connected. */
    enabled?: boolean;
    /** Chrome binary; empty auto-detects from the usual per-OS locations. */
    chromePath?: string;
    /** user-data-dir of the dedicated environment. */
    profileDir?: string;
    /** Pages opened on launch. */
    urls?: string[];
    /** Extra Chrome switches appended verbatim. */
    extraArgs?: string[];
    /** Handshake budget per launch attempt, in milliseconds. */
    waitMs?: number;
    /** Rescue script run when the handshake times out (session-scoped CDP load). */
    bootstrapScript?: string;
}
export declare const Config: z<Config>;
/** Cordis plugin entry: wire the listener lifecycle plus the model-facing tools. */
export declare function apply(ctx: Context, config: Config): void;
