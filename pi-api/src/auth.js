const crypto = require("crypto");

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function bearerAuth(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) {
    console.error("API_SECRET is not configured");
    return res.status(500).json({ ok: false, error: "Server misconfigured" });
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const token = header.slice("Bearer ".length);
  if (!timingSafeEqual(token, secret)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
}

function ipAllowlist(req, res, next) {
  const allowed = process.env.ALLOWED_IPS;
  if (!allowed) {
    return next();
  }

  const ips = allowed.split(",").map((ip) => ip.trim()).filter(Boolean);
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;

  if (!ips.includes(clientIp)) {
    console.warn(`Blocked request from disallowed IP: ${clientIp}`);
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }

  next();
}

module.exports = { bearerAuth, ipAllowlist };
