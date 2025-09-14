const fs = require('fs');
const path = require('path');
const { loadJSON, saveJSON } = require('./file_manager');

function reconcileOutputLog(results, outputPath) {
    const previousLog = loadJSON(outputPath) || [];
    const currentIds = results.map(v => v.id);

    const updatedLog = previousLog.map(vehicle => {
        if (currentIds.includes(vehicle.id)) {
            return { ...vehicle, missingCount: 0 };
        } else {
            return {
                ...vehicle,
                missingCount: (vehicle.missingCount || 0) + 1
            };
        }
    });

    const finalLog = updatedLog.filter(v => v.missingCount < 2);
    const removed = updatedLog.filter(v => v.missingCount >= 2);

    return { finalLog, removed };
}

function archiveRemovedVehicles(removed, removedPath) {
    const now = new Date().toISOString();
    const archive = fs.existsSync(removedPath)
        ? JSON.parse(fs.readFileSync(removedPath, 'utf-8'))
        : [];

    const enriched = removed.map(v => ({ ...v, removedAt: now }));
    archive.push(...enriched);

    fs.writeFileSync(removedPath, JSON.stringify(archive, null, 2));
}

module.exports = {
    reconcileOutputLog,
    archiveRemovedVehicles
};
