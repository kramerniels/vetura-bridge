const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { renderSetupPage, renderPairedPage, PUBLIC_DIR } = require("./view-controller");
const { listLanAddresses } = require("./network");
const { applyPairing } = require("./apply");
const { ensureIdentity, STATE_PAIRED } = require("../identity");

const MIME = {
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
};

// TODO Remove when manual setup is removed
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

// Write an HTTP response: strings as HTML, other values as JSON.
function send(res, status, body, headers = {}) {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type":
            typeof body === "string"
                ? "text/html; charset=utf-8"
                : "application/json",
        ...headers,
    });
    res.end(payload);
}

/**
 * Resolve a request path to a file under PUBLIC_DIR, blocking path traversal.
 * Returns null if the resolved path would escape PUBLIC_DIR.
 */
function safePublicPath(urlPath) {
    const rel = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const full = path.join(PUBLIC_DIR, rel);
    if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== PUBLIC_DIR) {
        return null;
    }
    return full;
}

function serveStaticFiles(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    if (!pathname.startsWith("/css/") && !pathname.startsWith("/js/"))
        return false;

    const filePath = safePublicPath(pathname.slice(1));
    if (!filePath) {
        send(res, 404, { error: "Not found" });
        return true;
    }

    let data;
    try {
        data = fs.readFileSync(filePath);
    } catch (err) {
        if (err.code === "ENOENT") {
            send(res, 404, { error: "Not found" });
            return true;
        }
        throw err;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
    });
    res.end(req.method === "HEAD" ? undefined : data);
    return true;
}

function getStatus(res, ctx) {
    const identity = ensureIdentity();
    return send(res, 200, {
        state: identity.state,
        deviceId: identity.deviceId,
        shortId: identity.shortId,
        addresses: listLanAddresses(),
        cloud: ctx.cloudLoop ? ctx.cloudLoop.getStatus() : null,
        pairUrl: ctx.pairUrl,
        worker: ctx.workerManager
            ? ctx.workerManager.getStatus()
            : { desired: false, running: false, pid: null, startedAt: null, restarts: 0, lastExitCode: null, lastExitAt: null, lastError: null },
    });
}

async function getIndex(res, ctx) {
    const identity = ensureIdentity();
    const html =
        identity.state === STATE_PAIRED
            ? renderPairedPage()
            : await renderSetupPage(ctx);
    return send(res, 200, html);
}

// TODO remove readBody as well
async function postManualSetup(res, req, ctx) {
    const identity = ensureIdentity();
    if (identity.state === "paired") {
        return send(res, 409, { ok: false, error: "Already paired" });
    }

    const form = JSON.parse((await readBody(req)) || "{}");
    const result = applyPairing({
        credsFileContents: form.creds,
        natsUrl: form.natsUrl,
        stream: form.stream,
        subject: form.subject,
        errorSubject: form.errorSubject,
        resultSubject: form.resultSubject,
        consumer: form.consumer,
        maxAgeSec: form.maxAgeSec,
    });

    if (!result.ok) {
        return send(res, 400, { ok: false, errors: result.errors });
    }

    if (ctx.onPaired) ctx.onPaired(result);
    return send(res, 200, { ok: true, config: result.config });
}

function createSetupServer(ctx) {
    const server = http.createServer(async (req, res) => {
        try {
            const host = req.headers.host || "localhost";
            const url = new URL(req.url || "/", `http://${host}`);

            // Router

            // Sever static file (css, js)
            if (serveStaticFiles(req, res, url.pathname)) return;

            if (req.method === "GET" && url.pathname === "/api/status") {
                return getStatus(res, ctx);
            }

            if (
                req.method === "GET" &&
                (url.pathname === "/" || url.pathname === "/index.html")
            ) {
                return await getIndex(res, ctx);
            }

            // TODO remove when manual setup is removed
            if (req.method === "POST" && url.pathname === "/api/manual-setup") {
                return await postManualSetup(res, req, ctx);
            }

            send(res, 404, { error: "Not found" });
        } catch (err) {
            console.error(err);
            send(res, 500, { error: err.message || "Internal error" });
        }
    });

    return server;
}

module.exports = { createSetupServer };
