/**
 * Example client for calling the Pi API from your external server.
 *
 * Usage:
 *   PI_API_URL=https://pi.example.com PI_API_SECRET=your-secret node examples/client.js
 */

const url = `${process.env.PI_API_URL}/api/run`;
const secret = process.env.PI_API_SECRET;

if (!process.env.PI_API_URL || !secret) {
  console.error("Set PI_API_URL and PI_API_SECRET");
  process.exit(1);
}

async function runCommand(command, data) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ command, data }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const result = await runCommand("setTemperature", {
    room: "woonkamer",
    value: 21,
  });
  console.log(result);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
