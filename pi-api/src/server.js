require("dotenv").config();

const express = require("express");
const rateLimit = require("express-rate-limit");
const { bearerAuth, ipAllowlist } = require("./auth");
const { validateRequest } = require("./commands");
const { runScript } = require("./runner");

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));

app.use(
  rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_MAX || 30),
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: "Too many requests" },
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, status: "healthy" });
});

app.post("/api/run", ipAllowlist, bearerAuth, async (req, res) => {
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  const startedAt = Date.now();

  const validation = validateRequest(req.body);
  if (!validation.ok) {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        ip: clientIp,
        event: "validation_failed",
        error: validation.error,
      })
    );
    return res.status(400).json({ ok: false, error: validation.error });
  }

  const { command, data, scriptPath } = validation;

  try {
    const result = await runScript(scriptPath, data);
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        ip: clientIp,
        event: "command_success",
        command,
        durationMs: Date.now() - startedAt,
      })
    );
    return res.json({ ok: true, result });
  } catch (err) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        ip: clientIp,
        event: "command_failed",
        command,
        durationMs: Date.now() - startedAt,
        error: err.message,
      })
    );
    return res.status(500).json({ ok: false, error: "Command execution failed" });
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

app.listen(port, host, () => {
  console.log(`pi-api listening on http://${host}:${port}`);
});
