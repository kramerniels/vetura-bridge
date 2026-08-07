const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

/**
 * Run a whitelisted root helper via `sudo -n` and parse JSON stdout.
 * @param {string} helperPath Absolute path under /usr/local/sbin
 * @param {string[]} [args]
 * @param {{ timeoutMs?: number, maxBuffer?: number, label?: string }} [options]
 */
async function runSudoHelper(helperPath, args = [], options = {}) {
    const {
        timeoutMs = 60_000,
        maxBuffer = 1024 * 1024,
        label = helperPath,
    } = options;

    let stdout;
    let stderr;

    try {
        const result = await execFileAsync(
            "sudo",
            ["-n", helperPath, ...args],
            {
                timeout: timeoutMs,
                maxBuffer,
            },
        );
        stdout = result.stdout;
        stderr = result.stderr;
    } catch (err) {
        const message = [err.stderr, err.stdout, err.message]
            .map((v) => (v == null ? "" : String(v).trim()))
            .filter(Boolean)
            .join("\n");
        throw new Error(message || `${label} failed`);
    }

    const raw = String(stdout || "").trim();
    if (!raw) {
        throw new Error(
            stderr
                ? String(stderr).trim()
                : `${label} returned empty stdout`,
        );
    }

    try {
        return JSON.parse(raw);
    } catch {
        throw new Error(
            `${label} returned non-JSON stdout: ${raw.slice(0, 500)}`,
        );
    }
}

module.exports = { runSudoHelper };
