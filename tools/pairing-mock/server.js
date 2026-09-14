"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3457);
const HOST = process.env.HOST || "0.0.0.0";
const CREDS_PATH = path.join(__dirname, "test_arjan_credentials.creds");
const DB_PATH = path.join(__dirname, "devices.json");

const BOOTSTRAP_SETTINGS = {
  natsUrl: "tls://nats.mnq.nl-ams.scaleway.com:4222",
  maxAgeSec: 3600,
};

let credsFileContents = "";
try {
  credsFileContents = fs.readFileSync(CREDS_PATH, "utf8");
} catch (err) {
  console.error(
    `Missing ${CREDS_PATH}. Place Scaleway NATS .creds next to server.js.`
  );
  process.exit(1);
}

function loadDevices() {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    const rows = data.devices && typeof data.devices === "object" ? data.devices : data;
    return new Map(Object.entries(rows || {}));
  } catch (err) {
    if (err.code === "ENOENT") return new Map();
    console.error(`Failed to read ${DB_PATH}:`, err.message);
    return new Map();
  }
}

function saveDevices(devices) {
  const rows = {};
  for (const [id, row] of devices.entries()) {
    rows[id] = row;
  }
  fs.writeFileSync(DB_PATH, `${JSON.stringify({ devices: rows }, null, 2)}\n`);
}

function getDevice(deviceId) {
  return loadDevices().get(deviceId) || null;
}

function setDevice(deviceId, row) {
  const devices = loadDevices();
  devices.set(deviceId, row);
  saveDevices(devices);
  return row;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendEmpty(res, status) {
  res.writeHead(status);
  res.end();
}

function logReq(method, pathname, status, detail) {
  const extra = detail ? ` ${detail}` : "";
  console.log(`${new Date().toISOString()} ${method} ${pathname} -> ${status}${extra}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loginPage(deviceId, claim, error) {
  return `<!DOCTYPE html>
<html>
<head><title>Pair device (mock)</title></head>
<body>
  <h1>Login</h1>
  <p>Fake login for local pairing mock. Any credentials work.</p>
  ${error ? `<p>${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="/devices/pair?deviceId=${encodeURIComponent(deviceId)}&claim=${encodeURIComponent(claim)}">
    <input type="hidden" name="action" value="login" />
    <div>
      <label>Username <input name="username" type="text" autocomplete="username" /></label>
    </div>
    <div>
      <label>Password <input name="password" type="password" autocomplete="current-password" /></label>
    </div>
    <button type="submit">Log in</button>
  </form>
</body>
</html>`;
}

function acceptPage(device) {
  return `<!DOCTYPE html>
<html>
<head><title>Pair device (mock)</title></head>
<body>
  <h1>Confirm pairing</h1>
  <p>Device ID: ${escapeHtml(device.deviceId)}</p>
  <p>Short ID: ${escapeHtml(device.shortId)}</p>
  <p>Status: ${escapeHtml(device.status)}</p>
  <form method="POST" action="/api/devices/${encodeURIComponent(device.deviceId)}/pair">
    <button type="submit">Accept</button>
  </form>
</body>
</html>`;
}

function provisioningPage(deviceId) {
  return `<!DOCTYPE html>
<html>
<head><title>Provisioning (mock)</title></head>
<body>
  <h1>Bezig met koppelen</h1>
  <p>Device ${escapeHtml(deviceId)}</p>
  <p id="msg">Bezig met aanmaken van certificaten…</p>
  <p>Status: <span id="status">provisioning</span></p>
  <script>
    async function poll() {
      const res = await fetch('/api/devices/${encodeURIComponent(deviceId)}');
      if (!res.ok) {
        setTimeout(poll, 1000);
        return;
      }
      const data = await res.json();
      document.getElementById('status').textContent = data.status;
      if (data.status === 'paired') {
        document.body.innerHTML =
          '<h1>Paired</h1><p>Device ${escapeHtml(deviceId)} is paired. The Pi will finish via bootstrap.</p>';
        return;
      }
      if (data.status === 'failed') {
        document.getElementById('msg').textContent =
          'Mislukt: ' + (data.provisioningError || 'onbekende fout');
        return;
      }
      setTimeout(poll, 1000);
    }
    setTimeout(poll, 1000);
  </script>
</body>
</html>`;
}

function pairedPage(deviceId) {
  return `<!DOCTYPE html>
<html>
<head><title>Paired (mock)</title></head>
<body>
  <h1>Paired</h1>
  <p>Device ${escapeHtml(deviceId)} is paired. The Pi will finish via bootstrap.</p>
</body>
</html>`;
}

function failedPage(deviceId, error) {
  return `<!DOCTYPE html>
<html>
<head><title>Pairing failed (mock)</title></head>
<body>
  <h1>Koppelen mislukt</h1>
  <p>Device ${escapeHtml(deviceId)}</p>
  <p>${escapeHtml(error || "Provisioning failed")}</p>
  <form method="POST" action="/api/devices/${encodeURIComponent(deviceId)}/pair">
    <button type="submit">Opnieuw proberen</button>
  </form>
</body>
</html>`;
}

function errorPage(message, status) {
  return `<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body>
  <h1>${status}</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function parseForm(body) {
  const params = new URLSearchParams(body);
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

async function handleRegister(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return sendJson(res, 400, { error: "invalid json" });
  }

  const deviceId = String(body.deviceId || "").trim();
  const claimSecret = String(body.claimSecret || "").trim();
  const shortId = String(body.shortId || "").trim();

  if (!deviceId || !claimSecret) {
    return sendJson(res, 400, { error: "deviceId and claimSecret required" });
  }

  const existing = getDevice(deviceId);
  if (existing && existing.claimSecret !== claimSecret) {
    logReq("POST", "/api/devices/register", 409, `claim mismatch ${deviceId}`);
    return sendJson(res, 409, { error: "deviceId exists with different claim" });
  }

  if (!existing) {
    setDevice(deviceId, {
      claimSecret,
      shortId: shortId || deviceId.replace(/-/g, "").slice(0, 8),
      status: "pending",
      bootstrapReady: false,
    });
    logReq("POST", "/api/devices/register", 201, `new ${deviceId}`);
    return sendJson(res, 201, { ok: true, deviceId, status: "pending" });
  }

  logReq("POST", "/api/devices/register", 200, `existing ${deviceId} ${existing.status}`);
  return sendJson(res, 200, { ok: true, deviceId, status: existing.status });
}

function handlePairPageGet(req, res, url) {
  const deviceId = url.searchParams.get("deviceId") || "";
  const claim = url.searchParams.get("claim") || "";
  const step = url.searchParams.get("step") || "";
  const device = getDevice(deviceId);

  if (!deviceId || !claim) {
    logReq("GET", "/devices/pair", 400, "missing params");
    return sendHtml(res, 400, errorPage("deviceId and claim query params required", 400));
  }
  if (!device) {
    logReq("GET", "/devices/pair", 404, `unknown ${deviceId}`);
    return sendHtml(res, 404, errorPage("Unknown device. Register first.", 404));
  }
  if (device.claimSecret !== claim) {
    logReq("GET", "/devices/pair", 403, "claim mismatch");
    return sendHtml(res, 403, errorPage("Claim mismatch", 403));
  }

  // Only show accept after a successful login POST (step=confirm in the URL).
  // Do not use a sticky cookie — that skipped login on later QR opens.
  if (step === "confirm" || step === "done") {
    if (device.status === "provisioning") {
      logReq("GET", "/devices/pair", 200, `provisioning ${deviceId}`);
      return sendHtml(res, 200, provisioningPage(deviceId));
    }
    if (device.status === "paired") {
      logReq("GET", "/devices/pair", 200, `paired ${deviceId}`);
      return sendHtml(res, 200, pairedPage(deviceId));
    }
    if (device.status === "failed") {
      logReq("GET", "/devices/pair", 200, `failed ${deviceId}`);
      return sendHtml(res, 200, failedPage(deviceId, device.provisioningError));
    }
    logReq("GET", "/devices/pair", 200, `confirm ${deviceId}`);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": "fake=; Path=/; Max-Age=0",
    });
    res.end(
      acceptPage({
        deviceId,
        shortId: device.shortId,
        status: device.status,
      })
    );
    return;
  }

  logReq("GET", "/devices/pair", 200, `login ${deviceId}`);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Set-Cookie": "fake=; Path=/; Max-Age=0",
  });
  res.end(loginPage(deviceId, claim));
}

async function handlePairPagePost(req, res, url) {
  const deviceId = url.searchParams.get("deviceId") || "";
  const claim = url.searchParams.get("claim") || "";
  const device = getDevice(deviceId);

  if (!device || device.claimSecret !== claim) {
    logReq("POST", "/devices/pair", 403, "invalid device or claim");
    return sendHtml(res, 403, errorPage("Invalid device or claim", 403));
  }

  const raw = await readBody(req);
  const form = parseForm(raw);
  void form.username;
  void form.password;

  const qs = new URLSearchParams({
    deviceId,
    claim,
    step: "confirm",
  });
  logReq("POST", "/devices/pair", 303, `login ok -> confirm ${deviceId}`);
  res.writeHead(303, {
    Location: `/devices/pair?${qs.toString()}`,
    "Set-Cookie": "fake=; Path=/; Max-Age=0",
  });
  res.end();
}

async function handlePairConfirm(req, res, deviceId, wantsHtml) {
  const device = getDevice(deviceId);
  if (!device) {
    logReq("POST", `/api/devices/${deviceId}/pair`, 404, "unknown");
    if (wantsHtml) return sendHtml(res, 404, errorPage("Unknown device", 404));
    return sendJson(res, 404, { error: "unknown device" });
  }

  await readBody(req);

  if (device.status === "paired") {
    logReq("POST", `/api/devices/${deviceId}/pair`, 200, "already paired");
    if (wantsHtml) return sendHtml(res, 200, pairedPage(deviceId));
    return sendJson(res, 200, { ok: true, deviceId, status: "paired" });
  }

  if (device.status === "provisioning") {
    logReq("POST", `/api/devices/${deviceId}/pair`, 200, "already provisioning");
    if (wantsHtml) return sendHtml(res, 200, provisioningPage(deviceId));
    return sendJson(res, 200, { ok: true, deviceId, status: "provisioning" });
  }

  device.status = "provisioning";
  device.bootstrapReady = false;
  device.provisioningError = null;
  device.provisioningStartedAt = new Date().toISOString();
  setDevice(deviceId, device);

  const delayMs = Number(process.env.PROVISION_DELAY_MS || 3000);
  setTimeout(() => {
    const current = getDevice(deviceId);
    if (!current || current.status !== "provisioning") return;
    current.status = "paired";
    current.bootstrapReady = true;
    current.pairedAt = new Date().toISOString();
    setDevice(deviceId, current);
    console.log(
      `${new Date().toISOString()} job complete paired ${deviceId} after ${delayMs}ms`
    );
  }, delayMs);

  logReq(
    "POST",
    `/api/devices/${deviceId}/pair`,
    200,
    `provisioning started delay=${delayMs}ms`
  );

  if (wantsHtml) {
    return sendHtml(res, 200, provisioningPage(deviceId));
  }
  return sendJson(res, 200, { ok: true, deviceId, status: "provisioning" });
}

function handleDeviceGet(req, res, deviceId) {
  const device = getDevice(deviceId);
  const pathLabel = `/api/devices/${deviceId}`;
  if (!device) {
    logReq("GET", pathLabel, 404, "unknown");
    return sendJson(res, 404, { error: "unknown device" });
  }
  logReq("GET", pathLabel, 200, device.status);
  return sendJson(res, 200, {
    deviceId,
    shortId: device.shortId,
    status: device.status,
    provisioningError: device.provisioningError || null,
  });
}

function handleBootstrap(req, res, deviceId) {
  const device = getDevice(deviceId);
  const token = bearerToken(req);
  const pathLabel = `/api/devices/${deviceId}/bootstrap`;

  if (!device) {
    logReq("GET", pathLabel, 404, "unknown device");
    return sendEmpty(res, 404);
  }
  if (!token || token !== device.claimSecret) {
    logReq(
      "GET",
      pathLabel,
      401,
      `claim mismatch tokenLen=${token.length} expectedLen=${device.claimSecret.length}`
    );
    return sendJson(res, 401, { error: "unauthorized" });
  }
  if (!device.bootstrapReady || device.status !== "paired") {
    logReq("GET", pathLabel, 204, `not ready status=${device.status}`);
    return sendEmpty(res, 204);
  }

  logReq("GET", pathLabel, 200, "bootstrap payload");
  return sendJson(res, 200, {
    natsUrl: BOOTSTRAP_SETTINGS.natsUrl,
    credsFileContents,
    maxAgeSec: BOOTSTRAP_SETTINGS.maxAgeSec,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const method = req.method || "GET";
    const pathname = url.pathname;

    if (method === "POST" && pathname === "/api/devices/register") {
      return await handleRegister(req, res);
    }

    if (pathname === "/devices/pair") {
      if (method === "GET") return handlePairPageGet(req, res, url);
      if (method === "POST") return await handlePairPagePost(req, res, url);
    }

    const pairMatch = /^\/api\/devices\/([^/]+)\/pair$/.exec(pathname);
    if (pairMatch && method === "POST") {
      const deviceId = decodeURIComponent(pairMatch[1]);
      const accept = req.headers.accept || "";
      const contentType = req.headers["content-type"] || "";
      const wantsHtml =
        contentType.includes("application/x-www-form-urlencoded") ||
        accept.includes("text/html");
      return await handlePairConfirm(req, res, deviceId, wantsHtml);
    }

    const bootstrapMatch = /^\/api\/devices\/([^/]+)\/bootstrap$/.exec(pathname);
    if (bootstrapMatch && method === "GET") {
      const deviceId = decodeURIComponent(bootstrapMatch[1]);
      return handleBootstrap(req, res, deviceId);
    }

    const deviceMatch = /^\/api\/devices\/([^/]+)$/.exec(pathname);
    if (deviceMatch && method === "GET") {
      const deviceId = decodeURIComponent(deviceMatch[1]);
      return handleDeviceGet(req, res, deviceId);
    }

    if (method === "GET" && pathname === "/api/devices") {
      const devices = Object.fromEntries(loadDevices());
      return sendJson(res, 200, { devices });
    }

    if (method === "GET" && pathname === "/") {
      return sendHtml(
        res,
        200,
        `<!DOCTYPE html><html><body><h1>pairing-mock</h1><p>DB: devices.json</p><p>Listening. Pair via /devices/pair?deviceId=...&amp;claim=...</p></body></html>`
      );
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal error" });
    }
  }
});

server.listen(PORT, HOST, () => {
  const count = loadDevices().size;
  console.log(`pairing-mock listening on http://${HOST}:${PORT}`);
  console.log(`DB ${DB_PATH} (${count} device(s))`);
  console.log(`Set CLOUD_API_URL and CLOUD_FRONTEND_URL to http://<lan-ip>:${PORT} on the Pi`);
});
