const path = require("path");

const SCRIPTS_DIR = path.join(__dirname, "scripts");

/**
 * Allowed commands → script path.
 * Each script exports `{ schema, timeoutMs? }` (`timeoutMs` null/omit = no limit).
 */
const scriptWhitelist = {
    printLabel: path.join(SCRIPTS_DIR, "print-label.js"),
    ping: path.join(SCRIPTS_DIR, "ping.js"),
    systemUpdate: path.join(SCRIPTS_DIR, "system-update.js"),
    systemReboot: path.join(SCRIPTS_DIR, "system-reboot.js"),
    setHeartbeatInterval: path.join(SCRIPTS_DIR, "set-heartbeat-interval.js"),
    update: path.join(SCRIPTS_DIR, "update.js"),
};

function commandFromSubject(subject) {
    const parts = String(subject || "").split(".");
    return parts[parts.length - 1] || "";
}

function validateRequest(body, command) {
    const scriptPath = scriptWhitelist[command];
    if (!scriptPath) {
        return {
            ok: false,
            error: {
                formErrors: [`Unknown command: ${command || "missing"}`],
                fieldErrors: {},
            },
        };
    }

    const { schema, timeoutMs = null } = require(scriptPath);
    if (!schema || typeof schema.safeParse !== "function") {
        return {
            ok: false,
            error: {
                formErrors: [`Command script missing schema: ${command}`],
                fieldErrors: {},
            },
        };
    }

    const validatedData = schema.safeParse(body);
    if (!validatedData.success) {
        return { ok: false, error: validatedData.error.flatten() };
    }

    return {
        ok: true,
        command,
        data: validatedData.data,
        scriptPath,
        timeoutMs,
    };
}

module.exports = {
    validateRequest,
    commandFromSubject,
    scriptWhitelist,
};
