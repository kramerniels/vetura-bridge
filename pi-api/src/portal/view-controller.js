const fs = require("fs");
const path = require("path");
const Mustache = require("mustache");
const QRCode = require("qrcode");
const { listLanAddresses } = require("./network");
const { configFromDeviceDefaults, DEFAULTS } = require("./apply");
const { ensureIdentity } = require("../identity");
const { subjectsForDevice } = require("../device-nats");

const PUBLIC_DIR = path.join(__dirname, "public");

function renderTemplate(file, data) {
    const template = fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8");
    return Mustache.render(template, data);
}

function baseData(identity) {
    return {
        deviceId: identity.deviceId,
        mdnsHost: `dkgm-${identity.shortId}.local`,
        addresses: listLanAddresses()
            .map((item) => item.address)
            .filter(Boolean)
            .join(", "),
    };
}

function cloudErrorFrom(ctx) {
    const cloud = ctx.cloudLoop ? ctx.cloudLoop.getStatus() : null;
    if (!cloud) return "";
    if (!cloud.cloudConfigured) return cloud.lastError || "";
    return cloud.lastError || "";
}

async function renderSetupPage(ctx) {
    const identity = ensureIdentity();
    const defaults = {
        ...configFromDeviceDefaults(identity.deviceId),
        natsUrl: DEFAULTS.NATS_URL,
        maxAgeSec: DEFAULTS.NATS_MAX_AGE_SEC,
    };

    let qrDataUrl = "";
    if (ctx.pairUrl) {
        qrDataUrl = await QRCode.toDataURL(ctx.pairUrl, {
            margin: 1,
            width: 240,
            errorCorrectionLevel: "M",
        });
    }

    return renderTemplate("setup.html", {
        ...baseData(identity),
        pairUrl: ctx.pairUrl || "",
        qrDataUrl,
        cloudError: cloudErrorFrom(ctx),
        creds: "",
        natsUrl: defaults.natsUrl || "",
        stream: defaults.stream || "commands",
        subject: defaults.subject || "",
        errorSubject: defaults.errorSubject || "",
        consumer: defaults.consumer || "",
        maxAgeSec: String(defaults.maxAgeSec || "3600"),
    });
}

function renderPairedPage() {
    const identity = ensureIdentity();
    const subjects = subjectsForDevice(identity.deviceId);
    return renderTemplate("paired.html", {
        ...baseData(identity),
        consumer: subjects.consumer,
        subject: subjects.subject,
        errorSubject: subjects.errorSubject,
    });
}

module.exports = { renderSetupPage, renderPairedPage, PUBLIC_DIR };
