const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STATE_UNPAIRED = "unpaired";
const STATE_PAIRED = "paired";
const STATE_FILE =
    process.platform === "darwin" || process.platform === "win32"
        ? path.join(process.cwd(), ".vetura-agent-runtime", "state.json")
        : "/var/lib/vetura-agent/state.json";

function generateSecret() {
    return crypto
        .randomBytes(32)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function validateIdentity(data) {
    if (!data || typeof data !== "object") {
        throw new Error("Invalid identity state: expected object");
    }
    if (!data.deviceId || typeof data.deviceId !== "string") {
        throw new Error("Invalid identity state: missing deviceId");
    }
    if (!data.claimSecret || typeof data.claimSecret !== "string") {
        throw new Error("Invalid identity state: missing claimSecret");
    }
    if (data.state !== STATE_UNPAIRED && data.state !== STATE_PAIRED) {
        throw new Error(`Invalid pairing state: ${data.state}`);
    }
    return {
        deviceId: data.deviceId.trim(),
        claimSecret: data.claimSecret.trim(),
        state: data.state,
    };
}

function readIdentity() {
    if (!fs.existsSync(STATE_FILE)) return null;
    return validateIdentity(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
}

function writeIdentity(identity) {
    const validated = validateIdentity(identity);
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
    const payload = `${JSON.stringify(
        {
            deviceId: validated.deviceId,
            claimSecret: validated.claimSecret,
            state: validated.state,
        },
        null,
        2,
    )}\n`;
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
        fs.writeFileSync(fd, payload);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, STATE_FILE);
    return validated;
}

function ensureIdentity() {
    let identity = readIdentity();

    if (!identity) {
        identity = writeIdentity({
            deviceId: crypto.randomUUID(),
            claimSecret: generateSecret(),
            state: STATE_UNPAIRED,
        });
    }

    return {
        ...identity,
        shortId: identity.deviceId.replace(/-/g, "").slice(0, 8).toLowerCase(),
        stateFile: STATE_FILE,
    };
}

function setState(nextState) {
    if (nextState !== STATE_UNPAIRED && nextState !== STATE_PAIRED) {
        throw new Error(`Invalid pairing state: ${nextState}`);
    }
    const current = ensureIdentity();
    writeIdentity({
        deviceId: current.deviceId,
        claimSecret: current.claimSecret,
        state: nextState,
    });
    return nextState;
}

function main() {
    const identity = ensureIdentity();
    console.log(
        JSON.stringify({
            deviceId: identity.deviceId,
            shortId: identity.shortId,
            state: identity.state,
            stateFile: identity.stateFile,
            hostname: `vetura-${identity.shortId}`,
        }),
    );
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = {
    STATE_UNPAIRED,
    STATE_PAIRED,
    STATE_FILE,
    readIdentity,
    ensureIdentity,
    setState,
};
