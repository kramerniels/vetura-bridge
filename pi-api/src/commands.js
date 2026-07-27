const path = require("path");
const { z } = require("zod");

const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");

const commandSchemas = {
  setTemperature: z
    .object({
      room: z.string().min(1).max(64),
      value: z.number().min(10).max(35),
    })
    .strict(),
  toggleLight: z
    .object({
      room: z.string().min(1).max(64),
      state: z.enum(["on", "off"]),
    })
    .strict(),
};

const commandScripts = {
  setTemperature: path.join(SCRIPTS_DIR, "set-temperature.js"),
  toggleLight: path.join(SCRIPTS_DIR, "toggle-light.js"),
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
