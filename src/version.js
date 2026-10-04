const fs = require("fs");
const path = require("path");

function packageVersion() {
    try {
        const pkgPath = path.join(__dirname, "..", "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        return pkg.version || null;
    } catch {
        return null;
    }
}

module.exports = { packageVersion };
