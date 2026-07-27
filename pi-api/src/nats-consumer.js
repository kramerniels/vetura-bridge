const {
  AckPolicy,
  DeliverPolicy,
  JSONCodec,
  RetentionPolicy,
} = require("nats");
const { connectNats } = require("./nats-client");

const codec = JSONCodec();

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

async function processCommand(nc, config, body) {
  const { validateRequest } = require("./commands");
  const { runScript } = require("./runner");
  const { isTransientError, buildErrorPayload } = require("./errors");

  const validation = validateRequest(body);
  if (!validation.ok) {
    const error = new Error("Validation failed");
    error.validation = validation.error;
    error.permanent = true;
    throw error;
  }

  const { command, data, scriptPath } = validation;
  await runScript(scriptPath, data);
  return command;
}

function logEvent(event, fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
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

  for await (const msg of messages) {
    const messageId = String(msg.info.streamSequence);
    let body;

    try {
      body = codec.decode(msg.data);
      logEvent("message_received", { messageId, subject: msg.subject, body });

      const command = await processCommand(nc, config, body);
      msg.ack();
      logEvent("message_success", { messageId, command });
    } catch (err) {
      const command = body?.command || "unknown";
      const permanent = err.permanent || !isTransientError(err);
      const errorMessage =
        err.validation != null
          ? JSON.stringify(err.validation)
          : err.message || String(err);

      if (permanent) {
        await publishError(
          nc,
          config,
          buildErrorPayload(command, messageId, { message: errorMessage })
        );
        msg.ack();
        logEvent("message_failed", {
          messageId,
          command,
          permanent: true,
          error: errorMessage,
        });
      } else {
        msg.nak();
        logEvent("message_retry", {
          messageId,
          command,
          permanent: false,
          error: errorMessage,
        });
      }
    }
  }
}

if (require.main === module) {
  require("dotenv").config();
  startConsumer().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { ensureJetStream, startConsumer, publishError };
