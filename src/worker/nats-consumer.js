const {
    AckPolicy,
    DeliverPolicy,
    JSONCodec,
    RetentionPolicy,
} = require("nats");
const { connectNats } = require("./nats-client");
const {
    isTransientError,
    retryDelayMs,
    errorReason,
    buildErrorPayload,
    buildResultPayload,
} = require("./errors");
const { commandFromSubject, validateRequest } = require("./commands");
const { runScript } = require("./runner");
const heartbeat = require("./heartbeat");

const codec = JSONCodec();

// A transient failure is redelivered; on this delivery the worker gives up,
// reports on the error subject and acks.
const MAX_ATTEMPTS = 3;
// Queued and running messages get their ack timer extended this often.
const WORKING_INTERVAL_MS = 10_000;

async function ensureJetStream(nc, config) {
    const jsm = await nc.jetstreamManager();
    const maxAgeNs = config.maxAgeSec * 1_000_000_000;

    try {
        await jsm.streams.info(config.stream);
        await jsm.streams.update(config.stream, {
            subjects: ["commands.>"],
            retention: RetentionPolicy.Workqueue,
            max_age: maxAgeNs,
        });
        console.log(`JetStream stream "${config.stream}" updated`);
    } catch {
        await jsm.streams.add({
            name: config.stream,
            subjects: ["commands.>"],
            retention: RetentionPolicy.Workqueue,
            max_age: maxAgeNs,
        });
        console.log(`JetStream stream "${config.stream}" created`);
    }

    try {
        await jsm.consumers.info(config.stream, config.consumer);
        console.log(`JetStream consumer "${config.consumer}" already exists`);
    } catch {
        await jsm.consumers.add(config.stream, {
            durable_name: config.consumer,
            filter_subject: config.subject,
            ack_policy: AckPolicy.Explicit,
            deliver_policy: DeliverPolicy.All,
        });
        console.log(`JetStream consumer "${config.consumer}" created`);
    }
}

async function publishError(nc, config, payload) {
    nc.publish(config.errorSubject, codec.encode(payload));
    await nc.flush();
}

async function publishResult(nc, config, payload) {
    nc.publish(config.resultSubject, codec.encode(payload));
    await nc.flush();
}

async function processCommand(nc, config, body, subject) {
    const command = commandFromSubject(subject || config.subject);
    const validation = validateRequest(body, command);
    if (!validation.ok) {
        const error = new Error("Validation failed");
        error.validation = validation.error;
        error.command = command;
        error.permanent = true;
        throw error;
    }

    const { data, scriptPath, timeoutMs } = validation;
    const result = await runScript(scriptPath, data, { timeoutMs });
    return { command, result };
}

function logEvent(event, fields) {
    console.log(
        JSON.stringify({ ts: new Date().toISOString(), event, ...fields }),
    );
}

// Jobs for one printer run in order; different printers run side by side, so a
// dead printer only delays its own jobs. All other commands share one queue.
function queueKey(subject, body) {
    if (commandFromSubject(subject) === "printLabel" && body && body.ip) {
        return `printer:${body.ip}:${body.port}`;
    }
    return "device";
}

// What the cloud needs to tell the user which job and printer failed.
function errorDetails(command, body, err, attempts) {
    const details = { attempts };
    const reason = errorReason(err);
    if (reason) details.reason = reason;
    if (command === "printLabel" && body && typeof body === "object") {
        for (const field of ["jobId", "printerId", "ip", "port"]) {
            if (body[field] != null) details[field] = body[field];
        }
    }
    return details;
}

async function handleMessage(nc, config, msg, body, decodeError) {
    const messageId = String(msg.info.streamSequence);

    try {
        if (decodeError) throw decodeError;
        logEvent("message_received", {
            messageId,
            subject: msg.subject,
            body,
        });

        const { command, result } = await processCommand(
            nc,
            config,
            body,
            msg.subject,
        );
        if (command === "setHeartbeatInterval") {
            heartbeat.setIntervalSec(result.intervalSec);
        }
        await publishResult(
            nc,
            config,
            buildResultPayload(command, messageId, result),
        );
        msg.ack();
        logEvent("message_success", { messageId, command });
    } catch (err) {
        const command =
            err.command || commandFromSubject(msg.subject) || "unknown";
        const permanent = err.permanent || !isTransientError(err);
        const attempts = msg.info.deliveryCount;
        const errorMessage =
            err.validation != null
                ? JSON.stringify(err.validation)
                : err.message || String(err);

        if (permanent || attempts >= MAX_ATTEMPTS) {
            await publishError(
                nc,
                config,
                buildErrorPayload(
                    command,
                    messageId,
                    { message: errorMessage },
                    errorDetails(command, body, err, attempts),
                ),
            );
            msg.ack();
            logEvent("message_failed", {
                messageId,
                command,
                permanent,
                attempts,
                error: errorMessage,
            });
        } else {
            msg.nak(retryDelayMs(err));
            logEvent("message_retry", {
                messageId,
                command,
                permanent: false,
                attempts,
                error: errorMessage,
            });
        }
    }
}

async function startConsumer() {
    const { nc, config } = await connectNats();
    await ensureJetStream(nc, config);

    const js = nc.jetstream();
    const consumer = await js.consumers.get(config.stream, config.consumer);
    const messages = await consumer.consume();

    logEvent("nats_connected", {
        url: config.url,
        stream: config.stream,
        subject: config.subject,
        consumer: config.consumer,
    });

    heartbeat.start(nc, config);

    const queues = new Map();
    const inFlight = new Map();
    const keepAlive = setInterval(() => {
        for (const msg of inFlight.values()) msg.working();
    }, WORKING_INTERVAL_MS);
    if (typeof keepAlive.unref === "function") keepAlive.unref();

    for await (const msg of messages) {
        const sequence = msg.info.streamSequence;
        // Redelivered while its earlier delivery is still queued or running here.
        if (inFlight.has(sequence)) continue;
        inFlight.set(sequence, msg);

        let body;
        let decodeError = null;
        try {
            body = codec.decode(msg.data);
        } catch (err) {
            decodeError = err;
        }

        const key = queueKey(msg.subject, body);
        const tail = (queues.get(key) || Promise.resolve())
            .then(() => handleMessage(nc, config, msg, body, decodeError))
            .catch((err) => {
                // Not acked: the server redelivers it after ack_wait.
                logEvent("message_handler_error", {
                    messageId: String(sequence),
                    error: err.message || String(err),
                });
            })
            .finally(() => {
                inFlight.delete(sequence);
                if (queues.get(key) === tail) queues.delete(key);
            });
        queues.set(key, tail);
    }

    clearInterval(keepAlive);
}

module.exports = {
    ensureJetStream,
    startConsumer,
    handleMessage,
    queueKey,
    publishError,
    publishResult,
};
