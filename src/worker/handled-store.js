const fs = require("fs");
const path = require("path");

/**
 * Remembers which stream messages the worker has already handled, so a
 * redelivery (lost ack, ack_wait expired while the message sat in a stalled
 * TCP buffer, worker restart) is acked and skipped instead of run again. A
 * second run of printLabel is a second label on the printer.
 *
 * Persisted to disk so it survives a worker restart. Entries are kept for
 * longer than the stream's max_age; a message older than that can't be
 * redelivered.
 */
const STORE_FILE =
    process.platform === "darwin" || process.platform === "win32"
        ? path.join(process.cwd(), ".vetura-agent-runtime", "handled.json")
        : "/var/lib/vetura-agent/handled.json";

function logEvent(event, fields) {
    console.log(
        JSON.stringify({ ts: new Date().toISOString(), event, ...fields }),
    );
}

/**
 * Stream sequence plus the stream's publish time: the pair stays the same
 * across redeliveries, and still differs if the stream is ever recreated and
 * its sequence numbers start over.
 */
function messageKey(msg) {
    return `${msg.info.streamSequence}:${msg.info.timestampNanos}`;
}

function createHandledStore(retentionMs, file = STORE_FILE) {
    // key -> handledAt (ms)
    const entries = new Map();

    try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const [key, at] of Object.entries(raw)) {
            if (Number.isFinite(at)) entries.set(key, at);
        }
    } catch (err) {
        if (err.code !== "ENOENT") {
            logEvent("handled_store_load_failed", {
                file,
                error: err.message || String(err),
            });
        }
    }

    function prune(now) {
        for (const [key, at] of entries) {
            if (now - at > retentionMs) entries.delete(key);
        }
    }

    function save() {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            const tmp = `${file}.${process.pid}.tmp`;
            const fd = fs.openSync(tmp, "w", 0o600);
            try {
                fs.writeFileSync(fd, JSON.stringify(Object.fromEntries(entries)));
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(tmp, file);
        } catch (err) {
            // The in-memory set still covers redeliveries until the worker restarts.
            logEvent("handled_store_save_failed", {
                file,
                error: err.message || String(err),
            });
        }
    }

    prune(Date.now());

    return {
        has(key) {
            return entries.has(key);
        },
        add(key) {
            const now = Date.now();
            prune(now);
            entries.set(key, now);
            save();
        },
    };
}

module.exports = { createHandledStore, messageKey, STORE_FILE };
