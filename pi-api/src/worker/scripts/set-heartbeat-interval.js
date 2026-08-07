const { z } = require("zod");
const { readStdin } = require("./lib/read-stdin");

const timeoutMs = 5_000;
const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 86400;

const schema = z
    .object({
        intervalSec: z
            .number()
            .int()
            .min(MIN_INTERVAL_SEC)
            .max(MAX_INTERVAL_SEC),
    })
    .strict();

function run(data) {
    return { intervalSec: data.intervalSec };
}

async function main() {
    const raw = await readStdin();
    const parsed = schema.safeParse(raw == null || raw === "" ? {} : raw);
    if (!parsed.success) {
        process.stderr.write(JSON.stringify(parsed.error.flatten()));
        process.exit(1);
    }

    const result = run(parsed.data);
    process.stdout.write(JSON.stringify(result));
}

module.exports = { schema, run, timeoutMs };

if (require.main === module) {
    main().catch((err) => {
        process.stderr.write(err.message);
        process.exit(1);
    });
}
