const { JSONCodec } = require("nats");
const { readIdentity } = require("../identity");
const { buildResultPayload } = require("./errors");

const codec = JSONCodec();

const DEFAULT_INTERVAL_SEC = 3600;
const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 86400;

let intervalSec = DEFAULT_INTERVAL_SEC;
let timer = null;
let nc = null;
let config = null;

function logEvent(event, fields) {
    console.log(
        JSON.stringify({ ts: new Date().toISOString(), event, ...fields }),
    );
}

function clampIntervalSec(sec) {
    const n = Number(sec);
    if (!Number.isInteger(n) || n < MIN_INTERVAL_SEC || n > MAX_INTERVAL_SEC) {
        throw new Error(
            `intervalSec must be an integer between ${MIN_INTERVAL_SEC} and ${MAX_INTERVAL_SEC}`,
        );
    }
    return n;
}

async function publishBeat() {
    if (!nc || !config) return;

    const identity = readIdentity();
    const deviceId = identity?.deviceId || null;
    const timestamp = new Date().toISOString();
    const payload = buildResultPayload("heartbeat", null, {
        deviceId,
        intervalSec,
        timestamp,
    });

    try {
        nc.publish(config.resultSubject, codec.encode(payload));
        await nc.flush();
        logEvent("heartbeat_published", {
            deviceId,
            intervalSec,
            subject: config.resultSubject,
        });
    } catch (err) {
        logEvent("heartbeat_failed", {
            deviceId,
            intervalSec,
            error: err.message || String(err),
        });
    }
}

function clearTimer() {
    if (timer != null) {
        clearInterval(timer);
        timer = null;
    }
}

function schedule() {
    clearTimer();
    timer = setInterval(() => {
        publishBeat().catch(() => {});
    }, intervalSec * 1000);
    if (typeof timer.unref === "function") timer.unref();
}

function start(natsConnection, natsConfig) {
    nc = natsConnection;
    config = natsConfig;
    intervalSec = DEFAULT_INTERVAL_SEC;
    publishBeat().catch(() => {});
    schedule();
    logEvent("heartbeat_started", { intervalSec });
}

function stop() {
    clearTimer();
    nc = null;
    config = null;
    logEvent("heartbeat_stopped", {});
}

function setIntervalSec(sec) {
    intervalSec = clampIntervalSec(sec);
    schedule();
    logEvent("heartbeat_interval_updated", { intervalSec });
    return intervalSec;
}

function getIntervalSec() {
    return intervalSec;
}

module.exports = {
    DEFAULT_INTERVAL_SEC,
    MIN_INTERVAL_SEC,
    MAX_INTERVAL_SEC,
    start,
    stop,
    setIntervalSec,
    getIntervalSec,
};
