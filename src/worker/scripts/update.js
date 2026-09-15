const { z } = require("zod");
const { readStdin } = require("./lib/read-stdin");
const { runSudoHelper } = require("./lib/run-sudo-helper");

const HELPER_PATH = "/usr/local/sbin/vetura-agent-app-update";
const timeoutMs = 300_000;

const schema = z
    .object({
        url: z
            .string()
            .url()
            .refine((value) => value.startsWith("https://"), {
                message: "url must use https://",
            }),
    })
    .strict();

async function run(data) {
    return runSudoHelper(HELPER_PATH, [data.url], {
        timeoutMs,
        maxBuffer: 1024 * 1024,
        label: "update helper",
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
