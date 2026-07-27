/**
 * Subscribe to error messages published by the Pi.
 *
 * Usage:
 *   NATS_URL=... NATS_CREDS_FILE=... node examples/error-subscriber.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { JSONCodec, StringCodec } = require("nats");
const { connectNats } = require("../src/nats-client");

const codec = JSONCodec();
const stringCodec = StringCodec();

async function main() {
  const { nc, config } = await connectNats();
  const subject = process.env.NATS_ERROR_SUBJECT || "errors.>";

  console.log(`Listening for errors on ${subject}`);

  const sub = nc.subscribe(subject);
  for await (const msg of sub) {
    let body;
    try {
      body = codec.decode(msg.data);
    } catch {
      body = stringCodec.decode(msg.data);
    }

    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        subject: msg.subject,
        body,
      })
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
