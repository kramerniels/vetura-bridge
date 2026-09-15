const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { z } = require("zod");
const { readStdin } = require("./lib/read-stdin");
const { listLanAddresses } = require("../../portal/network");
const { readIdentity } = require("../../identity");

const execFileAsync = promisify(execFile);
const timeoutMs = 10_000;

const schema = z.object({}).strict();

const DISK_PATHS = ["/", "/opt", "/var"];

function packageVersion() {
    try {
        const pkgPath = path.join(__dirname, "..", "..", "..", "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        return pkg.version || null;
    } catch {
        return null;
    }
}

function installDir() {
    if (fs.existsSync("/opt/vetura-agent")) return "/opt/vetura-agent";
    return process.cwd();
}

async function diskViaStatfs(mountPath) {
    if (typeof fs.promises.statfs !== "function") return null;
    try {
        const stats = await fs.promises.statfs(mountPath);
        const bsize = Number(stats.bsize);
        return {
            path: mountPath,
            totalBytes: bsize * Number(stats.blocks),
            freeBytes: bsize * Number(stats.bfree),
            availableBytes: bsize * Number(stats.bavail),
        };
    } catch {
        return null;
    }
}

async function diskViaDf(mountPath) {
    try {
        const { stdout } = await execFileAsync("df", ["-kP", mountPath], {
            timeout: 5_000,
        });
        const lines = String(stdout).trim().split("\n");
        if (lines.length < 2) return null;
        const parts = lines[lines.length - 1].split(/\s+/);
        if (parts.length < 4) return null;
        const totalKb = Number(parts[1]);
        const availableKb = Number(parts[3]);
        const usedKb = Number(parts[2]);
        if (![totalKb, availableKb, usedKb].every(Number.isFinite)) return null;
        return {
            path: mountPath,
            totalBytes: totalKb * 1024,
            freeBytes: (totalKb - usedKb) * 1024,
            availableBytes: availableKb * 1024,
        };
    } catch {
        return null;
    }
}

async function diskForPath(mountPath) {
    if (!fs.existsSync(mountPath)) return null;
    return (await diskViaStatfs(mountPath)) || (await diskViaDf(mountPath));
}

async function collectDisk() {
    const entries = [];
    for (const mountPath of DISK_PATHS) {
        const info = await diskForPath(mountPath);
        if (info) entries.push(info);
    }
    return entries;
}

function deviceInfo() {
    try {
        const identity = readIdentity();
        if (!identity) return null;
        return {
            deviceId: identity.deviceId,
            shortId: identity.deviceId.replace(/-/g, "").slice(0, 8).toLowerCase(),
            state: identity.state,
        };
    } catch {
        return null;
    }
}

async function run() {
    const mem = process.memoryUsage();
    const uptime = os.uptime();
    return {
        app: {
            version: packageVersion(),
            installDir: installDir(),
        },
        runtime: {
            node: process.version,
            pid: process.pid,
            uptimeSec: Math.round(process.uptime()),
        },
        os: {
            hostname: os.hostname(),
            platform: os.platform(),
            arch: os.arch(),
            release: os.release(),
            uptimeSec: Number.isFinite(uptime) ? Math.round(uptime) : null,
        },
        memory: {
            totalBytes: os.totalmem(),
            freeBytes: os.freemem(),
            rss: mem.rss,
            heapUsed: mem.heapUsed,
        },
        disk: await collectDisk(),
        network: listLanAddresses(),
        device: deviceInfo(),
        timestamp: new Date().toISOString(),
    };
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
