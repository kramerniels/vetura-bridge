const { z } = require("zod");
const { readStdin } = require("./lib/read-stdin");
const { runSudoHelper } = require("./lib/run-sudo-helper");

const HELPER_PATH = "/usr/local/sbin/pi-api-system-reboot";
const timeoutMs = 15_000;

const schema = z.object({}).strict();

async function run() {
    return runSudoHelper(HELPER_PATH, [], {
        timeoutMs,
        maxBuffer: 64 * 1024,
        label: "systemReboot helper",
    });
}

async function main() {
    const raw = await readStdin();
    const parsed = schema.safeParse(raw == null || raw === "" ? {} : raw);
    if (!parsed.success) {
        process.stderr.write(JSON.stringify(parsed.error.flatten()));
        process.exit(1);
    }

    const result = await run();
    process.stdout.write(JSON.stringify(result));
}

module.exports = { schema, run, timeoutMs };

if (require.main === module) {
    main().catch((err) => {
        process.stderr.write(err.message);
        process.exit(1);
    });
}
