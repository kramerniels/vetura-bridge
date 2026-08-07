/**
 * Worker process entry. Spawned by the portal worker-manager when the device
 * is paired. Env (NATS_*) is injected by the parent; do not load .env here.
 */
const { startConsumer } = require("./nats-consumer");

startConsumer().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
