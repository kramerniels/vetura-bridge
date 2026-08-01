const { ensureIdentity, STATE_PAIRED } = require("../identity");
const { startCloudLoop } = require("./cloud");
const { createSetupServer } = require("./server");
const { applyPairing, configFromBootstrap } = require("./apply");

const PORT = process.platform === "darwin" || process.platform === "win32" ? 8080 : 80;
const HOST = "0.0.0.0";

async function main() {
    const identity = ensureIdentity();

    if (identity.state === STATE_PAIRED) {
        console.log(
            JSON.stringify({
                ts: new Date().toISOString(),
                event: "already_paired",
                deviceId: identity.deviceId,
            }),
        );
    }

    let pairingLock = false;

    const ctx = {
        pairUrl: null,
        cloudLoop: null,
        onPaired() {
            if (ctx.cloudLoop) ctx.cloudLoop.stop();
        },
    };

    if (identity.state !== STATE_PAIRED) {
        const cloudLoop = startCloudLoop(identity, {
            async onBootstrap(payload) {
                if (pairingLock) return false;
                pairingLock = true;
                try {
                    const current = ensureIdentity();
                    if (current.state === STATE_PAIRED) return true;

                    const validated = configFromBootstrap(
                        payload,
                        current.deviceId,
                    );
                    const result = applyPairing(validated);
                    if (!result.ok) {
                        console.error(
                            JSON.stringify({
                                ts: new Date().toISOString(),
                                event: "bootstrap_apply_failed",
                                errors: result.errors,
                            }),
                        );
                        pairingLock = false;
                        return false;
                    }

                    console.log(
                        JSON.stringify({
                            ts: new Date().toISOString(),
                            event: "paired_via_bootstrap",
                            deviceId: current.deviceId,
                            consumer: result.config.consumer,
                        }),
                    );
                    ctx.onPaired(result);
                    return true;
                } catch (err) {
                    pairingLock = false;
                    console.error(
                        JSON.stringify({
                            ts: new Date().toISOString(),
                            event: "bootstrap_apply_failed",
                            error: err.message,
                        }),
                    );
                    return false;
                }
            },
            onError(err) {
                console.error(
                    JSON.stringify({
                        ts: new Date().toISOString(),
                        event: "cloud_loop_error",
                        error: err.message,
                    }),
                );
            },
            onRegistered() {
                console.log(
                    JSON.stringify({
                        ts: new Date().toISOString(),
                        event: "device_registered",
                        deviceId: identity.deviceId,
                    }),
                );
            },
        });

        ctx.cloudLoop = cloudLoop;
        ctx.pairUrl = cloudLoop.pairUrl;
    }

    const server = createSetupServer(ctx);
    server.listen(PORT, HOST, () => {
        console.log(
            JSON.stringify({
                ts: new Date().toISOString(),
                event: "setup_listening",
                host: HOST,
                port: PORT,
                deviceId: identity.deviceId,
                shortId: identity.shortId,
                state: identity.state,
                pairUrl: ctx.pairUrl,
                mdns: `dkgm-${identity.shortId}.local`,
            }),
        );
    });

    const shutdown = () => {
        if (ctx.cloudLoop) ctx.cloudLoop.stop();
        server.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

if (require.main === module) {
    require("dotenv").config();
    main().catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}
