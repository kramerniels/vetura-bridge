const { readStdin } = require("./lib/read-stdin");

async function main() {
  const { room, state } = await readStdin();

  // Replace with your real integration (GPIO, MQTT, Home Assistant, etc.).
  const result = {
    room,
    state,
    applied: true,
    message: `Light in ${room} turned ${state}`,
  };

  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stderr.write(err.message);
  process.exit(1);
});
