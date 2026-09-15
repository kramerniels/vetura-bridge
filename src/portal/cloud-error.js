const { listLanAddresses } = require("./network");

const DNS_CODES = new Set([
    "EAI_AGAIN",
    "ENOTFOUND",
    "EAI_NONAME",
    "EAI_FAIL",
    "EAI_NODATA",
]);

const NO_ROUTE_CODES = new Set(["ENETUNREACH", "EHOSTUNREACH"]);

const TEMPORARY_CODES = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
]);

function hasLanAddress() {
    return listLanAddresses().length > 0;
}

function friendlyCloudError(err, options = {}) {
    if (!err) return "";
    const message = err.message || String(err);
    const code = err.code || "";
    const hasLan =
        options.hasLan != null ? options.hasLan : hasLanAddress();

    if (/CLOUD_API_URL is not set/.test(message)) {
        return "Cloud-configuratie ontbreekt. CLOUD_API_URL is niet ingesteld.";
    }

    if (!hasLan) {
        return "Geen netwerkverbinding. Controleer of de ethernetkabel is aangesloten.";
    }

    if (
        DNS_CODES.has(code) ||
        NO_ROUTE_CODES.has(code) ||
        /getaddrinfo|EAI_AGAIN|ENOTFOUND/.test(message)
    ) {
        return "Geen internetverbinding. Controleer of de ethernetkabel is aangesloten en of het netwerk internet heeft.";
    }

    if (TEMPORARY_CODES.has(code) || /timed out/i.test(message)) {
        return "De online omgeving is tijdelijk niet bereikbaar. Probeer het later opnieuw.";
    }

    return "Kan de online omgeving niet bereiken. Controleer de netwerkverbinding.";
}

module.exports = { friendlyCloudError };
