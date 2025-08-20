const specWeights = {
    "Technology Plus Pack": 4,
    "Comfort Plus Pack": 4,
    "Sky Lounge": 4,
    "Soft-close Doors": 1,
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

const requiredSpecs = [
    "Comfort Plus Pack",
    "Driving Assistant Professional"
];

const maxScore = Object.values(specWeights).reduce((sum, val) => sum + val, 0); // 44

function evaluateSpecs(vehicle) {
    const specText = vehicle.specs?.join(" ").toLowerCase();
    const matchedSpecs = [];
    let specScore = 0;

    for (const [keyword, weight] of Object.entries(specWeights)) {
        if (specText?.includes(keyword.toLowerCase())) {
            matchedSpecs.push(keyword);
            specScore += weight;
        }
    }

    const missingRequired = requiredSpecs.filter(req => !matchedSpecs.includes(req));
    const scorePercent = Math.round((specScore / maxScore) * 100);

    return {
        ...vehicle,
        matchedSpecs,
        specScore,
        scorePercent,
        meetsRequirements: missingRequired.length === 0,
        missingRequired
    };
}

module.exports = { evaluateSpecs };