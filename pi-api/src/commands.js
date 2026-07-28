const path = require("path");
const { z } = require("zod");

const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");

const commandSchemas = {
  printLabel: z
    .object({
      jobId: z.string().min(1),
      organizationId: z.string().min(1),
      printerId: z.string().min(1),
      zpl: z.string().min(1).max(500_000),
      ip: z.string().ip(),
      port: z.coerce.number().int().min(1).max(65535),
      copies: z.coerce.number().int().min(1).max(100).default(1),
    })
    .strict(),
};

const commandScripts = {
  printLabel: path.join(SCRIPTS_DIR, "print-label.js"),
};

function commandFromSubject(subject) {
  const parts = String(subject || "").split(".");
  return parts[parts.length - 1] || "";
}

function validateRequest(body, command) {
  if (!commandScripts[command]) {
    return {
      ok: false,
      error: {
        formErrors: [`Unknown command: ${command || "missing"}`],
        fieldErrors: {},
      },
    };
  }

  const dataSchema = commandSchemas[command];
  const validatedData = dataSchema.safeParse(body);
  if (!validatedData.success) {
    return { ok: false, error: validatedData.error.flatten() };
  }

  return {
    ok: true,
    command,
    data: validatedData.data,
    scriptPath: commandScripts[command],
  };
}

module.exports = {
  validateRequest,
  commandFromSubject,
  commandSchemas,
  commandScripts,
};
