const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");

const PACKAGE_ROOT = path.join(__dirname, "../..");
const WORKER_SCRIPT = path.join(__dirname, "../worker/nats-consumer.js");
const APP_DIR =
    process.platform === "darwin" || process.platform === "win32"
        ? path.join(process.cwd(), ".pi-api-runtime")
        : "/opt/pi-api";
const ENV_FILE = path.join(APP_DIR, ".env");

const STOP_TIMEOUT_MS = 5000;
const RESTART_MIN_MS = 1000;
const RESTART_MAX_MS = 30000;

function logEvent(event, fields = {}) {
    console.log(
        JSON.stringify({ ts: new Date().toISOString(), event, ...fields }),
    );
}

function loadWorkerEnv() {
    const env = { ...process.env };
    if (fs.existsSync(ENV_FILE)) {
        const parsed = dotenv.parse(fs.readFileSync(ENV_FILE));
        Object.assign(env, parsed);
    }
    return env;
}

function createWorkerManager() {
    let child = null;
    let desired = false;
    let stopping = false;
    let startedAt = null;
    let restarts = 0;
    let lastExitCode = null;
    let lastExitAt = null;
    let lastError = null;
    let restartTimer = null;
    let restartDelayMs = RESTART_MIN_MS;
    let stopTimer = null;
    let stopResolve = null;

    function clearRestartTimer() {
        if (restartTimer) {
            clearTimeout(restartTimer);
            restartTimer = null;
        }
    }

    function clearStopTimer() {
        if (stopTimer) {
            clearTimeout(stopTimer);
            stopTimer = null;
        }
    }

    function pipeLine(stream, level) {
        let buf = "";
        stream.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            let idx;
            while ((idx = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, idx).replace(/\r$/, "");
                buf = buf.slice(idx + 1);
                if (!line) continue;
                if (level === "stderr") {
                    console.error(
                        JSON.stringify({
                            ts: new Date().toISOString(),
                            event: "worker_stderr",
                            line,
                        }),
                    );
                } else {
                    console.log(
                        JSON.stringify({
                            ts: new Date().toISOString(),
                            event: "worker_stdout",
                            line,
                        }),
                    );
                }
            }
        });
    }

    function scheduleRestart() {
        if (!desired || stopping) return;
        clearRestartTimer();
        const delay = restartDelayMs;
        restartDelayMs = Math.min(restartDelayMs * 2, RESTART_MAX_MS);
        logEvent("worker_restart_scheduled", { delayMs: delay, restarts });
        restartTimer = setTimeout(() => {
            restartTimer = null;
            if (!desired || stopping) return;
            restarts += 1;
            spawnWorker();
        }, delay);
    }

    function spawnWorker() {
        if (child || !desired || stopping) return;

        let env;
        try {
            env = loadWorkerEnv();
        } catch (err) {
            lastError = err.message || String(err);
            logEvent("worker_env_load_failed", { error: lastError });
            scheduleRestart();
            return;
        }

        if (!fs.existsSync(WORKER_SCRIPT)) {
            lastError = `Worker script not found: ${WORKER_SCRIPT}`;
            logEvent("worker_spawn_failed", { error: lastError });
            scheduleRestart();
            return;
        }

        try {
            child = spawn(process.execPath, [WORKER_SCRIPT], {
                cwd: PACKAGE_ROOT,
                env,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (err) {
            child = null;
            lastError = err.message || String(err);
            logEvent("worker_spawn_failed", { error: lastError });
            scheduleRestart();
            return;
        }

        startedAt = new Date().toISOString();
        lastError = null;
        pipeLine(child.stdout, "stdout");
        pipeLine(child.stderr, "stderr");

        logEvent("worker_started", { pid: child.pid, restarts });

        child.on("error", (err) => {
            lastError = err.message || String(err);
            logEvent("worker_error", { error: lastError });
        });

        child.on("exit", (code, signal) => {
            const exited = child;
            child = null;
            lastExitCode = code;
            lastExitAt = new Date().toISOString();
            startedAt = null;

            logEvent("worker_exited", {
                pid: exited && exited.pid,
                code,
                signal,
                desired,
                stopping,
            });

            if (stopping) {
                clearStopTimer();
                if (stopResolve) {
                    const resolve = stopResolve;
                    stopResolve = null;
                    resolve();
                }
                return;
            }

            if (desired) {
                if (code !== 0 && code != null) {
                    lastError = `Worker exited with code ${code}`;
                } else if (signal) {
                    lastError = `Worker exited with signal ${signal}`;
                }
                scheduleRestart();
            }
        });
    }

    function ensureStarted() {
        desired = true;
        stopping = false;
        clearRestartTimer();
        restartDelayMs = RESTART_MIN_MS;
        if (child) return { ok: true, alreadyRunning: true };
        spawnWorker();
        return { ok: true, alreadyRunning: false };
    }

    function stop() {
        desired = false;
        clearRestartTimer();

        if (!child) {
            stopping = false;
            return Promise.resolve();
        }

        stopping = true;
        const proc = child;

        return new Promise((resolve) => {
            stopResolve = resolve;
            try {
                proc.kill("SIGTERM");
            } catch (_) {
                /* already gone */
            }

            clearStopTimer();
            stopTimer = setTimeout(() => {
                stopTimer = null;
                if (child && child.pid === proc.pid) {
                    try {
                        proc.kill("SIGKILL");
                    } catch (_) {
                        /* ignore */
                    }
                }
            }, STOP_TIMEOUT_MS);
        }).finally(() => {
            stopping = false;
            clearStopTimer();
            stopResolve = null;
        });
    }

    function getStatus() {
        const running = Boolean(child && child.pid);
        return {
            desired,
            running,
            pid: running ? child.pid : null,
            startedAt: running ? startedAt : null,
            restarts,
            lastExitCode,
            lastExitAt,
            lastError,
        };
    }

    return { ensureStarted, stop, getStatus };
}

module.exports = { createWorkerManager, APP_DIR, ENV_FILE, WORKER_SCRIPT };
