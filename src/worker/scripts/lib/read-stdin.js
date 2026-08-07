function readStdin() {
    return new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            data += chunk;
        });
        process.stdin.on("end", () => {
            try {
                resolve(JSON.parse(data));
            } catch (err) {
                reject(new Error(`Invalid JSON on stdin: ${err.message}`));
            }
        });
        process.stdin.on("error", reject);
    });
}

module.exports = { readStdin };
