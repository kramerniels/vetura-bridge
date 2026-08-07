/**
 * Per-device JetStream subject / consumer naming.
 * Online publishers must use the same pattern for a given deviceId.
 *
 * Commands:  commands.<deviceId>.<command>
 * Errors:    errors.<deviceId>   (one topic for all commands)
 * Results:   results.<deviceId>  (one topic for all command successes)
 * Consumer:  filter commands.<deviceId>.>
 */

function subjectsForDevice(deviceId) {
    const id = String(deviceId).trim();
    if (!id) {
        throw new Error("deviceId is required");
    }
    return {
        stream: "commands",
        subject: `commands.${id}.>`,
        errorSubject: `errors.${id}`,
        resultSubject: `results.${id}`,
        consumer: `pi-${id}`,
    };
}

function commandSubject(deviceId, command) {
    const id = String(deviceId).trim();
    const cmd = String(command).trim();
    if (!id) throw new Error("deviceId is required");
    if (!cmd) throw new Error("command is required");
    return `commands.${id}.${cmd}`;
}

module.exports = { subjectsForDevice, commandSubject };
