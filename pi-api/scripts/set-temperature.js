const { readStdin } = require("./lib/read-stdin");

async function main() {
  const { room, value } = await readStdin();

  // Replace with your real integration (GPIO, MQTT, Home Assistant, etc.).
  const result = {
    room,
    value,
    applied: true,
    message: `Temperature set to ${value}°C in ${room}`,
  };

  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stderr.write(err.message);
  process.exit(1);
});
