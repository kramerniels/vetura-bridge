const { execFile } = require("child_process");
const { promisify } = require("util");
const { z } = require("zod");
const { readStdin } = require("./lib/read-stdin");

const execFileAsync = promisify(execFile);

const HELPER_PATH = "/usr/local/sbin/pi-api-system-update";
const timeoutMs = 45 * 60 * 1000;

const schema = z
    .object({
        recipe: z.enum(["fullUpgrade", "distUpgrade"]),
    })
    .strict();

async function run(data) {
    const { recipe } = data;
    let stdout;
    let stderr;

    try {
        const result = await execFileAsync(
            "sudo",
            ["-n", HELPER_PATH, recipe],
            {
                timeout: timeoutMs,
                maxBuffer: 2 * 1024 * 1024,
            },
        );
        stdout = result.stdout;
        stderr = result.stderr;
    } catch (err) {
        const message = [err.stderr, err.stdout, err.message]
            .map((v) => (v == null ? "" : String(v).trim()))
            .filter(Boolean)
            .join("\n");
        throw new Error(message || `systemUpdate helper failed (${recipe})`);
    }

    const raw = String(stdout || "").trim();
    if (!raw) {
        throw new Error(
            stderr
                ? String(stderr).trim()
                : "systemUpdate helper returned empty stdout",
        );
    }

    try {
        return JSON.parse(raw);
    } catch {
        throw new Error(
            `systemUpdate helper returned non-JSON stdout: ${raw.slice(0, 500)}`,
        );
    }
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
