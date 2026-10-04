const { z } = require("zod");
const { readStdin } = require("./lib/read-stdin");
const { runSudoHelper } = require("./lib/run-sudo-helper");
const { stageUnpairedEnv } = require("../../portal/apply");

const HELPER_PATH = "/usr/local/sbin/vetura-agent-unpair";
const timeoutMs = 15_000;

const schema = z
    .object({
        cloudApiUrl: z.string().url().optional(),
        cloudFrontendUrl: z.string().url().optional(),
    })
    .strict();

async function run(data) {
    // An unpaired device needs both to register and show its QR code. Agents
    // before 2.2.0 dropped them from .env when they paired, so the cloud can
    // send them along.
    const cloudApiUrl = data.cloudApiUrl || process.env.CLOUD_API_URL;
    const cloudFrontendUrl = data.cloudFrontendUrl || process.env.CLOUD_FRONTEND_URL;
    if (!cloudApiUrl || !cloudFrontendUrl) {
        throw new Error(
            "Cloud URLs are not known on this device; send cloudApiUrl and cloudFrontendUrl with unpair"
        );
    }

    stageUnpairedEnv({ cloudApiUrl, cloudFrontendUrl });

    return runSudoHelper(HELPER_PATH, [], {
        timeoutMs,
        maxBuffer: 64 * 1024,
        label: "unpair helper",
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
