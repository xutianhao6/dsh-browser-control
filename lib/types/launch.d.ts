/**
 * Dedicated-browser launcher.
 *
 * Chrome allows exactly one debugger client per tab, so a profile shared with
 * other debugger-hungry extensions (Claude, ChatGPT, screen recorders) makes
 * `chrome.debugger.attach` fail intermittently with
 * "Cannot access a chrome-extension:// URL of different extension". The fix is
 * an isolated user-data-dir that holds only the DSH Browser Control extension;
 * this module makes dsh bring that environment up on demand instead of asking
 * the user to launch it by hand before every task.
 *
 * Two deliberate properties:
 * - Spawning is idempotent at the OS level: launching Chrome again for an
 *   already-running user-data-dir is forwarded to the existing process (a new
 *   window/tab at most), never a second browser fighting for the same bridge.
 * - `--load-extension` is NOT used: Chrome 137+ removed the switch. The CDP
 *   `Extensions.loadUnpacked` path is scriptable but **session-scoped** — the
 *   extension is gone from the profile on the next start — so it only serves as
 *   `bootstrapScript` rescue. Durable installation means loading the unpacked
 *   extension once from `chrome://extensions` with developer mode on, exactly
 *   like the daily profile does.
 * @module @deepseek-ai/dsh-browser-bridge/launch
 */
/** Resolved `launch` settings, with every default already applied. */
export interface ResolvedLaunchConfig {
    /** Bring the dedicated browser up when no extension is connected. */
    enabled: boolean;
    /** Chrome binary; empty means "detect from the usual per-OS locations". */
    chromePath: string;
    /** user-data-dir of the dedicated environment; required when enabled. */
    profileDir: string;
    /** Pages opened on launch. */
    urls: string[];
    /** Extra Chrome switches appended verbatim. */
    extraArgs: string[];
    /** How long to wait for the extension handshake after launching. */
    waitMs: number;
    /**
     * Rescue script run when the handshake times out. It loads the unpacked
     * extension over CDP `Extensions.loadUnpacked`, which is **session-scoped**:
     * use it to unblock a task now, and load the extension from the extensions
     * page with developer mode on for a durable install.
     */
    bootstrapScript: string;
}
/** What the launcher needs from its owner; read lazily so settings stay live. */
export interface BrowserLauncherOptions {
    /** Currently resolved `launch` settings, or undefined before any config arrived. */
    readonly readConfig: () => ResolvedLaunchConfig | undefined;
    /** Whether the bridge currently holds an extension link. */
    readonly isConnected: () => boolean;
    /** Line logger for lifecycle diagnostics. */
    readonly log: (line: string) => void;
}
/**
 * Resolve the Chrome binary to launch.
 * @param explicit - configured `launch.chromePath`; wins when it exists on disk.
 * @returns the path to use, or undefined when nothing usable was found.
 */
export declare function detectChromePath(explicit: string): string | undefined;
/**
 * Brings the dedicated browser environment up when a `browser_*` call finds the
 * bridge without an extension link. Concurrent callers share one attempt, and a
 * failed attempt backs off so a misconfigured profile cannot fork Chrome on
 * every single tool call.
 */
export declare class BrowserLauncher {
    private readonly options;
    private inFlight;
    private lastAttemptAt;
    constructor(options: BrowserLauncherOptions);
    /**
     * Ensure an extension is connected, launching the dedicated environment when
     * configured to. Resolves once an attempt has been made; callers re-check the
     * link themselves. Never throws: a launch failure is logged and the original
     * "no extension connected" error stays the one the model sees.
     */
    ensureConnected(): Promise<void>;
    /** One launch attempt: spawn, wait for the handshake, bootstrap once if needed. */
    private attempt;
    /** Start a detached GUI process; the bridge talks to it over the extension, not stdio. */
    private spawnDetached;
    /** Poll until the bridge reports a link, or the budget runs out. */
    private waitForConnection;
    /**
     * Run the rescue script that loads the unpacked extension into `profileDir`
     * through CDP. Session-scoped by design (see {@link ResolvedLaunchConfig.bootstrapScript});
     * the script owns the messy part (debug port, loadUnpacked, status output).
     */
    private runBootstrap;
}
