const fs = require('fs');
const path = require('path');

function saveJSON(filePath, data, retries = 3, delayMs = 100) {
    const resolvedPath = path.resolve(filePath);
    const dir = path.dirname(resolvedPath);

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            fs.writeFileSync(resolvedPath, JSON.stringify(data, null, 2));
            return;
        } catch (err) {
            if (err.code === 'EBUSY' && attempt < retries) {
                console.warn(`⚠️ saveJSON: File busy (${filePath}), retrying in ${delayMs}ms...`);
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
            } else {
                console.error(`❌ saveJSON failed: ${err.message}`);
                throw err;
            }
        }
    }
}

function loadJSON(filePath) {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) return null;
    return JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
}

module.exports = { saveJSON, loadJSON };