const { spawn } = require("child_process");

const SCRIPT_TIMEOUT_MS = Number(process.env.SCRIPT_TIMEOUT_MS || 30_000);

function runScript(scriptPath, data) {
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

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Script timed out after ${SCRIPT_TIMEOUT_MS}ms`));
    }, SCRIPT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Script exited with code ${code}`));
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
