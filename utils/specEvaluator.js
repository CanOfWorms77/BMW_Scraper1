const specWeights = {
    "Technology Plus Pack": 4,
    "Comfort Plus Pack": 4,
    "Sky Lounge": 4,
    "Soft close Doors": 3,
    "Sun Protection Glass": 1,
    "Bowers & Wilkins": 4,
    "Front Massage Seats": 3,
    "Acoustic glass": 1,
    "M Electric Front Sport Seats": 2,
    "Carbon Fibre Interior Trim": 2,
    "M Sport Pro Pack": 2,
    "Comfort Pack": 2,
    "M Sport Brakes with Red Calipers": 1,
    "Driving Assistant Professional": 3,
    "Parking Assistant Pro": 2,
    "Heat Comfort System": 1,
    "Front and Rear Heated Seats": 2,
    "Ventilated Front Seats": 2,
    "Integral Active Steering": 2
};

const maxScore = Object.values(specWeights).reduce((sum, val) => sum + val, 0); // e.g. 44

function normalize(text) {
    return text.toLowerCase().replace(/[^\w\s]/gi, '');
}

function evaluateSpecs(vehicle) {
    const foundSpecs = vehicle.features || [];
    let score = 0;
    const matched = [];
    const matchedKeys = new Set();

    for (const spec of foundSpecs) {
        for (const [key, weight] of Object.entries(specWeights)) {
            if (spec.toLowerCase().includes(key.toLowerCase()) && !matchedKeys.has(key)) {
                score += weight;
                matched.push({ spec: key, matchedText: spec, weight });
                matchedKeys.add(key);
            }
        }
    }

    const scorePercent = Math.round((score / maxScore) * 100); // no cap — rare 100% is allowed

    const unmatchedSpecs = foundSpecs.filter(spec =>
        !matched.some(m => m.matchedText === spec)
    );

    return {
        ...vehicle,
        score,
        scorePercent,
        matchedSpecs: matched,
        unmatchedSpecs
    };
}

module.exports = { evaluateSpecs };