const { spawn } = require("child_process");

/**
 * @param {string} scriptPath
 * @param {unknown} data
 * @param {{ timeoutMs?: number | null }} [options]
 *   timeoutMs — positive ms to kill the child; null/undefined/0 = no timeout
 */
function runScript(scriptPath, data, options = {}) {
    const timeoutMs = options.timeoutMs;
    const hasTimeout = timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0;

    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                NODE_ENV: process.env.NODE_ENV || "production",
            },
        });

        let stdout = "";
        let stderr = "";
        let timer = null;

        if (hasTimeout) {
            timer = setTimeout(() => {
                child.kill("SIGTERM");
                reject(new Error(`Script timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("error", (err) => {
            if (timer) clearTimeout(timer);
            reject(err);
        });

        child.on("close", (code) => {
            if (timer) clearTimeout(timer);
            if (code !== 0) {
                reject(
                    new Error(
                        stderr.trim() || `Script exited with code ${code}`,
                    ),
                );
                return;
            }

            let result = stdout.trim();
            if (result) {
                try {
                    result = JSON.parse(result);
                } catch {
                    // Keep stdout as plain string when it is not JSON.
                }
            } else {
                result = null;
            }

            resolve(result);
        });

        child.stdin.write(JSON.stringify(data));
        child.stdin.end();
    });
}

module.exports = { runScript };
