const { z } = require("zod");
const { readStdin } = require("./lib/read-stdin");
const { runSudoHelper } = require("./lib/run-sudo-helper");

const HELPER_PATH = "/usr/local/sbin/vetura-agent-system-update";
const timeoutMs = 45 * 60 * 1000;

const schema = z
    .object({
        recipe: z.enum(["fullUpgrade", "distUpgrade"]),
    })
    .strict();

async function run(data) {
    const { recipe } = data;
    return runSudoHelper(HELPER_PATH, [recipe], {
        timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        label: `systemUpdate helper (${recipe})`,
    });
}

async function main() {
    const raw = await readStdin();
    const parsed = schema.safeParse(raw == null || raw === "" ? {} : raw);
    if (!parsed.success) {
        process.stderr.write(JSON.stringify(parsed.error.flatten()));
        process.exit(1);
    }

    const result = await run(parsed.data);
    process.stdout.write(JSON.stringify(result));
}

module.exports = { schema, run, timeoutMs };

if (require.main === module) {
    main().catch((err) => {
        process.stderr.write(err.message);
        process.exit(1);
    });
}
