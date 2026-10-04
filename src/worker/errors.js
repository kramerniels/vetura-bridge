function isLockError(message) {
    return (
        message.includes("Could not get lock") ||
        message.includes("Unable to acquire the dpkg frontend lock") ||
        message.includes("dpkg frontend is locked") ||
        message.includes("is another process using it")
    );
}

function isTransientError(err) {
    const message = err?.message || String(err);
    return (
        message.includes("Printer connection timed out") ||
        message.includes("Printer connection failed") ||
        message.includes("Printer send timed out") ||
        message.includes("Script timed out") ||
        isLockError(message)
    );
}

// Pause before a transient failure is redelivered. apt/dpkg locks take a while to clear.
function retryDelayMs(err) {
    return isLockError(err?.message || String(err)) ? 30_000 : 2_000;
}

// Short cause for the cloud UI; null when there is none.
function errorReason(err) {
    const message = err?.message || String(err);
    if (message.includes("Printer connection timed out")) return "connect timeout";
    if (message.includes("Printer connection failed")) return "connect failed";
    if (message.includes("Printer send timed out")) return "send timeout";
    return null;
}

function buildErrorPayload(command, messageId, error, details = {}) {
    return {
        command,
        messageId,
        error: error?.message || String(error),
        ...details,
        timestamp: new Date().toISOString(),
    };
}

function buildResultPayload(command, messageId, result) {
    return {
        command,
        messageId,
        result: result == null ? null : result,
        timestamp: new Date().toISOString(),
    };
}

module.exports = {
    isTransientError,
    retryDelayMs,
    errorReason,
    buildErrorPayload,
    buildResultPayload,
};
