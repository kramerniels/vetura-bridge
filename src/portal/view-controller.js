const fs = require("fs");
const path = require("path");
const Mustache = require("mustache");
const QRCode = require("qrcode");
const { listLanAddresses } = require("./network");
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
        mdnsHost: `vetura-${identity.shortId}.local`,
        addresses: listLanAddresses()
            .map((item) => item.address)
            .filter(Boolean)
            .join(", "),
    };
}

function cloudErrorFrom(ctx) {
    const cloud = ctx.cloudLoop ? ctx.cloudLoop.getStatus() : null;
    if (!cloud) return "";
    return cloud.userError || "";
}

async function renderSetupPage(ctx) {
    const identity = ensureIdentity();

    let qrDataUrl = "";
    if (ctx.pairUrl) {
        qrDataUrl = await QRCode.toDataURL(ctx.pairUrl, {
            margin: 1,
            width: 240,
            errorCorrectionLevel: "M",
            color: { dark: "#022c22", light: "#ffffff" },
        });
    }

    return renderTemplate("setup.html", {
        ...baseData(identity),
        pairUrl: ctx.pairUrl || "",
        qrDataUrl,
        cloudError: cloudErrorFrom(ctx),
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
        resultSubject: subjects.resultSubject,
    });
}

module.exports = { renderSetupPage, renderPairedPage, PUBLIC_DIR };
