const os = require("os");

function listLanAddresses() {
    let nets;
    try {
        nets = os.networkInterfaces();
    } catch {
        return [];
    }
    const addresses = [];

    for (const [name, entries] of Object.entries(nets || {})) {
        if (!entries) continue;
        if (
            name.startsWith("lo") ||
            name.startsWith("docker") ||
            name.startsWith("br-")
        ) {
            continue;
        }
        for (const entry of entries) {
            if (entry.internal) continue;
            if (entry.family !== "IPv4" && entry.family !== 4) continue;
            addresses.push({ interface: name, address: entry.address });
        }
    }

    return addresses;
}

module.exports = { listLanAddresses };
