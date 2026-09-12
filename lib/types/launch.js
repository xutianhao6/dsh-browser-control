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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
/** Per-platform Chrome locations tried when `chromePath` is not configured. */
const CHROME_CANDIDATES = {
    win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
    ],
    darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};
/** Poll interval while waiting for the extension to dial in. */
const POLL_INTERVAL_MS = 250;
/** Do not re-spawn within this window: a failed attempt must not fork Chrome per tool call. */
const RESPAWN_COOLDOWN_MS = 5_000;
/** Ceiling for the one-time bootstrap script. */
const BOOTSTRAP_TIMEOUT_MS = 90_000;
/** Expand `%LOCALAPPDATA%`-style prefixes in configured candidate paths. */
function expandEnv(value) {
    return value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);
}
/**
 * Resolve the Chrome binary to launch.
 * @param explicit - configured `launch.chromePath`; wins when it exists on disk.
 * @returns the path to use, or undefined when nothing usable was found.
 */
export function detectChromePath(explicit) {
    const configured = expandEnv(explicit.trim());
    if (configured.length > 0)
        return existsSync(configured) ? configured : undefined;
    for (const candidate of CHROME_CANDIDATES[process.platform] ?? []) {
        const expanded = expandEnv(candidate);
        if (existsSync(expanded))
            return expanded;
    }
    return undefined;
}
/**
 * Brings the dedicated browser environment up when a `browser_*` call finds the
 * bridge without an extension link. Concurrent callers share one attempt, and a
 * failed attempt backs off so a misconfigured profile cannot fork Chrome on
 * every single tool call.
 */
export class BrowserLauncher {
    options;
    inFlight;
    lastAttemptAt = 0;
    constructor(options) {
        this.options = options;
    }
    /**
     * Ensure an extension is connected, launching the dedicated environment when
     * configured to. Resolves once an attempt has been made; callers re-check the
     * link themselves. Never throws: a launch failure is logged and the original
     * "no extension connected" error stays the one the model sees.
     */
    async ensureConnected() {
        const config = this.options.readConfig();
        if (config === undefined || !config.enabled)
            return;
        if (this.options.isConnected())
            return;
        if (config.profileDir.trim().length === 0) {
            this.options.log('browser-bridge: launch.enabled 为真但没有配 profileDir，跳过自动拉起');
            return;
        }
        if (this.inFlight !== undefined)
            return this.inFlight;
        if (Date.now() - this.lastAttemptAt < RESPAWN_COOLDOWN_MS)
            return;
        this.inFlight = this.attempt(config)
            .catch((error) => {
            this.options.log(`browser-bridge: 拉起专属浏览器失败：${error instanceof Error ? error.message : String(error)}`);
        })
            .finally(() => {
            this.inFlight = undefined;
            this.lastAttemptAt = Date.now();
        });
        return this.inFlight;
    }
    /** One launch attempt: spawn, wait for the handshake, bootstrap once if needed. */
    async attempt(config) {
        const chrome = detectChromePath(config.chromePath);
        if (chrome === undefined) {
            this.options.log('browser-bridge: 找不到 Chrome —— 用 launch.chromePath 指定可执行文件');
            return;
        }
        this.options.log(`browser-bridge: 没有扩展连接，拉起专属浏览器 ${config.profileDir}`);
        this.spawnDetached(chrome, [
            `--user-data-dir=${config.profileDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            ...config.extraArgs,
            ...config.urls,
        ]);
        if (await this.waitForConnection(config.waitMs)) {
            this.options.log('browser-bridge: 专属浏览器已连接');
            return;
        }
        if (config.bootstrapScript.trim().length === 0) {
            this.options.log('browser-bridge: 等待扩展握手超时 —— 该 profile 里可能还没装 DSH Browser Control 扩展');
            return;
        }
        if (!existsSync(config.bootstrapScript)) {
            this.options.log(`browser-bridge: 引导脚本不存在：${config.bootstrapScript}`);
            return;
        }
        this.options.log(`browser-bridge: 握手超时，运行引导脚本 ${config.bootstrapScript}`);
        await this.runBootstrap(config.bootstrapScript, config.profileDir);
        if (await this.waitForConnection(config.waitMs)) {
            this.options.log('browser-bridge: 引导后扩展已连接');
            return;
        }
        this.options.log('browser-bridge: 引导后仍未连接 —— 请检查该 profile 里的扩展是否被停用或路径已失效');
    }
    /** Start a detached GUI process; the bridge talks to it over the extension, not stdio. */
    spawnDetached(command, args) {
        const child = spawn(command, args, { detached: true, stdio: 'ignore' });
        child.on('error', () => { });
        child.unref();
    }
    /** Poll until the bridge reports a link, or the budget runs out. */
    async waitForConnection(budgetMs) {
        const deadline = Date.now() + budgetMs;
        while (Date.now() < deadline) {
            if (this.options.isConnected())
                return true;
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        return this.options.isConnected();
    }
    /**
     * Run the rescue script that loads the unpacked extension into `profileDir`
     * through CDP. Session-scoped by design (see {@link ResolvedLaunchConfig.bootstrapScript});
     * the script owns the messy part (debug port, loadUnpacked, status output).
     */
    async runBootstrap(script, profileDir) {
        const args = process.platform === 'win32'
            ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProfileDir', profileDir]
            : [script, '-ProfileDir', profileDir];
        const command = process.platform === 'win32' ? 'powershell.exe' : 'bash';
        await new Promise((resolve) => {
            const child = spawn(command, args, { stdio: 'ignore' });
            const timer = setTimeout(() => {
                child.kill();
                resolve();
            }, BOOTSTRAP_TIMEOUT_MS);
            child.on('error', () => {
                clearTimeout(timer);
                resolve();
            });
            child.on('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}
