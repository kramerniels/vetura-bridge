const path = require("path");
const { z } = require("zod");

const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");

const commandSchemas = {
  printLabel: z
    .object({
      zpl: z.string().min(1).max(500_000),
      ip: z.string().ip(),
      port: z.coerce.number().int().min(1).max(65535),
    })
    .strict(),
};

const commandScripts = {
  printLabel: path.join(SCRIPTS_DIR, "print-label.js"),
};

const requestSchema = z
  .object({
    command: z.enum(Object.keys(commandScripts)),
    data: z.record(z.unknown()),
  })
  .strict();

function validateRequest(body) {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.flatten() };
  }

  const { command, data } = parsed.data;
  const dataSchema = commandSchemas[command];
  const validatedData = dataSchema.safeParse(data);
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

module.exports = { validateRequest, commandSchemas, commandScripts };
