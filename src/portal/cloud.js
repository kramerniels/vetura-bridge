const http = require("http");
const https = require("https");
const { URL } = require("url");

const DEFAULT_POLL_MS = 3000;
const DEFAULT_REGISTER_RETRY_MS = 10000;

function readEnvUrl(name) {
    return (process.env[name] || "").trim().replace(/\/$/, "");
}

function getCloudApiUrl() {
    const url = readEnvUrl("CLOUD_API_URL");
    if (!url) {
        throw new Error("CLOUD_API_URL is not set");
    }
    return url;
}

function getPairUrl(deviceId, claimSecret) {
    const base = readEnvUrl("CLOUD_FRONTEND_URL");
    if (!base) {
        return null;
    }
    const qs = new URLSearchParams({
        deviceId,
        claim: claimSecret,
    });
    return `${base}/devices/pair?${qs.toString()}`;
}

function requestJson(method, urlString, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const lib = url.protocol === "https:" ? https : http;
        const headers = {
            Accept: "application/json",
            ...(options.headers || {}),
        };
        let body = null;
        if (options.body != null) {
            body = Buffer.from(JSON.stringify(options.body), "utf8");
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = String(body.length);
        }

        const req = lib.request(
            {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || (url.protocol === "https:" ? 443 : 80),
                path: `${url.pathname}${url.search}`,
                method,
                headers,
                timeout: options.timeoutMs || 15000,
            },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    let json = null;
                    const contentType = res.headers["content-type"] || "";
                    if (contentType.includes("application/json") && text) {
                        try {
                            json = JSON.parse(text);
                        } catch {
                            json = null;
                        }
                    }
                    resolve({
                        status: res.statusCode || 0,
                        ok:
                            (res.statusCode || 0) >= 200 &&
                            (res.statusCode || 0) < 300,
                        text,
                        json,
                    });
                });
            },
        );

        req.on("timeout", () => {
            req.destroy(new Error("Request timed out"));
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

async function registerDevice(identity) {
    const cloudUrl = getCloudApiUrl();
    const response = await requestJson("POST", `${cloudUrl}/api/devices/register`, {
        body: {
            deviceId: identity.deviceId,
            claimSecret: identity.claimSecret,
            shortId: identity.shortId,
        },
    });

    if (!response.ok) {
        throw new Error(
            `Register failed (${response.status}): ${response.text.slice(0, 200)}`,
        );
    }

    return response.json || { ok: true };
}

async function fetchBootstrap(identity) {
    const cloudUrl = getCloudApiUrl();
    const response = await requestJson(
        "GET",
        `${cloudUrl}/api/devices/${encodeURIComponent(identity.deviceId)}/bootstrap`,
        {
            headers: {
                Authorization: `Bearer ${identity.claimSecret}`,
            },
        },
    );

    if (
        response.status === 404 ||
        response.status === 204 ||
        response.status === 409
    ) {
        return { ready: false, status: response.status };
    }

    if (response.status === 401 || response.status === 403) {
        throw new Error(
            `Bootstrap unauthorized (${response.status}): ${response.text.slice(0, 200)}`,
        );
    }

    if (!response.ok) {
        throw new Error(
            `Bootstrap failed (${response.status}): ${response.text.slice(0, 200)}`,
        );
    }

    const payload = response.json;
    if (!payload || !payload.credsFileContents) {
        return { ready: false, status: response.status };
    }

    return { ready: true, payload };
}

function startCloudLoop(identity, handlers = {}) {
    let timer = null;
    let status = {
        cloudConfigured: true,
        registered: false,
        stopped: false,
        lastError: null,
        lastRegisterAt: null,
        lastPollAt: null,
    };

    try {
        getCloudApiUrl();
    } catch (err) {
        status = {
            cloudConfigured: false,
            registered: false,
            stopped: true,
            lastError: err.message,
            lastRegisterAt: null,
            lastPollAt: null,
        };
        return {
            stop() {},
            getStatus: () => ({ ...status }),
            pairUrl: null,
        };
    }

    const pairUrl = getPairUrl(identity.deviceId, identity.claimSecret);

    async function tick() {
        if (status.stopped) return;

        try {
            if (!status.registered) {
                await registerDevice(identity);
                status.registered = true;
                status.lastRegisterAt = new Date().toISOString();
                status.lastError = null;
                if (handlers.onRegistered) handlers.onRegistered();
            }

            status.lastPollAt = new Date().toISOString();
            const result = await fetchBootstrap(identity);
            if (result.ready) {
                status.lastError = null;
                if (handlers.onBootstrap) {
                    const done = await handlers.onBootstrap(result.payload);
                    // Stop polling only when pairing actually succeeded. (new timeout is not set.)
                    if (done === true) return;
                } else {
                    return;
                }
            }
            status.lastError = null;
        } catch (err) {
            status.lastError = err.message;
            if (handlers.onError) handlers.onError(err);
        }

        if (!status.stopped) {
            const delay = status.registered
                ? DEFAULT_POLL_MS
                : DEFAULT_REGISTER_RETRY_MS;
            timer = setTimeout(tick, delay);
        }
    }

    timer = setTimeout(tick, 0);

    return {
        stop() {
            status.stopped = true;
            if (timer) clearTimeout(timer);
        },
        getStatus: () => ({ ...status }),
        pairUrl,
    };
}

module.exports = {
    startCloudLoop,
};
