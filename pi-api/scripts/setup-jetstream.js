require("dotenv").config();

const { connectNats } = require("../src/nats-client");
const { ensureJetStream } = require("../src/nats-consumer");

async function main() {
  const { nc, config } = await connectNats();
  await ensureJetStream(nc, config);
  await nc.drain();
  console.log("JetStream setup complete");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
