function isTransientError(err) {
    const message = err?.message || String(err);
    return (
        message.includes("Printer connection timed out") ||
        message.includes("Printer connection failed") ||
        message.includes("Script timed out")
    );
}

function buildErrorPayload(command, messageId, error) {
    return {
        command,
        messageId,
        error: error?.message || String(error),
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
    buildErrorPayload,
    buildResultPayload,
};
