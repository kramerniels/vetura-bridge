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
        // Not err.message: it repeats the command line, and the update
        // helper's argument is a presigned URL.
        const message = [err.stderr, err.stdout]
            .map((v) => (v == null ? "" : String(v).trim()))
            .filter(Boolean)
            .join("\n");
        throw new Error(
            message || `${label} failed${err.killed ? " (timed out)" : ""}`,
        );
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
