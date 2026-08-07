const net = require("net");
const { z } = require("zod");
const { readStdin } = require("./lib/read-stdin");

// Printer connection timeout
const CONNECT_TIMEOUT_MS = 10_000;
// Kill the child process if the print job hangs; null = no runner timeout.
const timeoutMs = 40_000;

const schema = z
    .object({
        jobId: z.string().min(1),
        organizationId: z.string().min(1),
        printerId: z.string().min(1),
        zpl: z.string().min(1).max(500_000),
        ip: z.string().ip(),
        port: z.coerce.number().int().min(1).max(65535),
        copies: z.coerce.number().int().min(1).max(100).default(1),
    })
    .strict();

function sendZpl(ip, port, zpl) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: ip, port }, () => {
            socket.write(zpl, "utf8", (err) => {
                if (err) {
                    socket.destroy();
                    reject(err);
                    return;
                }
                socket.end();
            });
        });

        socket.setTimeout(CONNECT_TIMEOUT_MS);

        socket.on("timeout", () => {
            socket.destroy();
            reject(
                new Error(
                    `Printer connection timed out after ${CONNECT_TIMEOUT_MS}ms (${ip}:${port})`,
                ),
            );
        });

        socket.on("error", (err) => {
            reject(
                new Error(
                    `Printer connection failed (${ip}:${port}): ${err.message}`,
                ),
            );
        });

        socket.on("close", () => {
            resolve();
        });
    });
}

async function run(data) {
    const { zpl, ip, port, copies = 1 } = data;
    const payload = copies > 1 ? zpl.repeat(copies) : zpl;

    await sendZpl(ip, port, payload);

    return {
        ip,
        port,
        copies,
        printed: true,
        bytesSent: Buffer.byteLength(payload, "utf8"),
    };
}

async function main() {
    const raw = await readStdin();
    const parsed = schema.safeParse(raw);
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
