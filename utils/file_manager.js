const fs = require('fs');
const path = require('path');

function saveJSON(filePath, data) {
    const resolvedPath = path.resolve(filePath);
    const dir = path.dirname(resolvedPath);

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(resolvedPath, JSON.stringify(data, null, 2));
}

function loadJSON(filePath) {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) return null;
    return JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
}

module.exports = { saveJSON, loadJSON };