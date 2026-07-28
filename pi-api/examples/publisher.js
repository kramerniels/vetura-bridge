/**
 * Publish a printLabel command to Scaleway NATS JetStream.
 *
 * Usage:
 *   NATS_URL=... NATS_CREDS_FILE=... node examples/publisher.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { JSONCodec } = require("nats");
const { connectNats } = require("../src/nats-client");

const codec = JSONCodec();

async function publishPrintLabel(payload) {
  const { nc, config } = await connectNats();
  const js = nc.jetstream();

  const ack = await js.publish(config.subject, codec.encode(payload));
  console.log(
    JSON.stringify({
      ok: true,
      subject: config.subject,
      stream: ack.stream,
      seq: ack.seq,
      payload,
    })
  );

  await nc.drain();
}

async function main() {
  await publishPrintLabel({
    jobId: crypto.randomUUID(),
    organizationId: process.env.ORGANIZATION_ID || "dkgm",
    printerId: process.env.PRINTER_ID || "printer_1785149244829",
    zpl: "^XA^FDTest^FS^XZ",
    ip: process.env.PRINTER_IP || "172.16.57.115",
    port: Number(process.env.PRINTER_PORT || 9100),
    copies: 1,
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
