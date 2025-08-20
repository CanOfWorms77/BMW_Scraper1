function formatEmailAlert(vehicle) {
    const subject = `X5 50e Alert — ${vehicle.scorePercent}% Spec Match`;

    const body = `
        🚗 ${vehicle.title}
        ⭐ Spec Score: ${vehicle.scorePercent}%
        ✅ Matched Specs: ${vehicle.matchedSpecs.join(', ') || 'None'}
        ${vehicle.meetsRequirements ? '' : `❌ Missing Required: ${vehicle.missingRequired.join(', ')}`}
        📍 Location: ${vehicle.location || 'Unknown'}
        💰 Price: ${vehicle.price || 'N/A'}
        🔗 ${vehicle.url}

        🕒 Scraped at: ${vehicle.timestamp}
        `;

    return { subject, body };
}

module.exports = { formatEmailAlert };