const dns = require("dns");
const fs = require("fs");
const { connect, credsAuthenticator } = require("nats");

dns.setDefaultResultOrder("ipv4first");

function normalizeServerUrl(url) {
    if (url.startsWith("nats://")) {
        return `tls://${url.slice("nats://".length)}`;
    }
    return url;
}

function parseServerUrl(url) {
    const normalized = normalizeServerUrl(url);
    const parsed = new URL(normalized.replace("tls://", "https://"));
    return {
        hostname: parsed.hostname,
        port: parsed.port || "4222",
        normalized,
    };
}

async function resolveServers(url) {
    const { hostname, port, normalized } = parseServerUrl(url);

    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        return { servers: [normalized] };
    }

    const addresses = await dns.promises.resolve4(hostname);
    if (addresses.length === 0) {
        throw new Error(`No IPv4 addresses found for ${hostname}`);
    }

    return {
        servers: addresses.map((ip) => `tls://${ip}:${port}`),
        tls: { servername: hostname },
    };
}

function loadConfig() {
    const url = process.env.NATS_URL;
    const credsFile = process.env.NATS_CREDS_FILE;

    if (!url || !credsFile) {
        throw new Error("NATS_URL and NATS_CREDS_FILE must be set");
    }

    if (!fs.existsSync(credsFile)) {
        throw new Error(`Credentials file not found: ${credsFile}`);
    }

    return {
        url: normalizeServerUrl(url),
        creds: fs.readFileSync(credsFile, "utf8"),
        stream: process.env.NATS_STREAM || "commands",
        subject: process.env.NATS_SUBJECT || "commands.>",
        errorSubject: process.env.NATS_ERROR_SUBJECT || "errors",
        consumer: process.env.NATS_CONSUMER || "pi-printer-1",
        maxAgeSec: Number(process.env.NATS_MAX_AGE_SEC || 900),
    };
}

async function connectNats() {
    const config = loadConfig();
    const { servers, tls } = await resolveServers(config.url);

    try {
        const nc = await connect({
            servers,
            tls,
            authenticator: credsAuthenticator(
                Buffer.from(config.creds, "utf8"),
            ),
            maxReconnectAttempts: -1,
            reconnectTimeWait: 2000,
            timeout: 15_000,
        });

        return { nc, config };
    } catch (err) {
        throw new Error(
            `Failed to connect to NATS at ${config.url} (${servers.join(", ")}): ${err.message}`,
        );
    }
}

module.exports = { connectNats, loadConfig, resolveServers };
