const net = require("net");
const { readStdin } = require("./lib/read-stdin");

const CONNECT_TIMEOUT_MS = 10_000;

function sendZpl(ip, port, zpl) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port }, () => {
      socket.write(zpl, "utf8", (err) => {
        if (err) {
          socket.destroy();
          reject(err);
          return;
        }
        socket.end();
      });
    });

    socket.setTimeout(CONNECT_TIMEOUT_MS);

    socket.on("timeout", () => {
      socket.destroy();
      reject(
        new Error(
          `Printer connection timed out after ${CONNECT_TIMEOUT_MS}ms (${ip}:${port})`
        )
      );
    });

    socket.on("error", (err) => {
      reject(new Error(`Printer connection failed (${ip}:${port}): ${err.message}`));
    });

    socket.on("close", () => {
      resolve();
    });
  });
}

async function main() {
  const { zpl, ip, port, copies = 1 } = await readStdin();
  const payload = copies > 1 ? zpl.repeat(copies) : zpl;

  await sendZpl(ip, port, payload);

  process.stdout.write(
    JSON.stringify({
      ip,
      port,
      copies,
      printed: true,
      bytesSent: Buffer.byteLength(payload, "utf8"),
    })
  );
}

main().catch((err) => {
  process.stderr.write(err.message);
  process.exit(1);
});
