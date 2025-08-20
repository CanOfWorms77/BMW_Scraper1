const fs = require('fs');
const path = require('path');

function loadJSON(filename)
{
    const filePath = path.join(__dirname, '../data', filename);
    if (!fs.existsSync(filePath)) return null;

    try
    {
        const raw = fs.readFileSync(filePath);
        return JSON.parse(raw);
    }
    catch (err)
    {
        console.error(`❌ Failed to parse ${filename}:`, err.message);
        return null;
    }
}

function saveJSON(filename, data)
{
    const filePath = path.join(__dirname, '../data', filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

module.exports = { loadJSON, saveJSON };