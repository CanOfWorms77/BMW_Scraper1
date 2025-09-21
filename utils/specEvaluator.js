const { getSpecWeights } = require('./specWeightLoader');

function normalize(text) {
  return text.toLowerCase().replace(/[^\w\s]/gi, '');
}

function evaluateSpecs(vehicle, currentModel = 'default') {
  const specWeights = getSpecWeights(currentModel) || {};
  const maxScore = Object.values(specWeights).reduce((sum, val) => sum + val, 0) || 1;

  const foundSpecs = vehicle.features || [];
  let score = 0;
  const matched = [];
  const matchedKeys = new Set();

  for (const spec of foundSpecs) {
    for (const [key, weight] of Object.entries(specWeights)) {
      if (normalize(spec).includes(normalize(key)) && !matchedKeys.has(key)) {
        score += weight;
        matched.push({ spec: key, matchedText: spec, weight });
        matchedKeys.add(key);
      }
    }
  }

  const scorePercent = Math.round((score / maxScore) * 100);
  const unmatchedSpecs = foundSpecs.filter(spec =>
    !matched.some(m => m.matchedText === spec)
  );

  return {
    ...vehicle,
    score,
    scorePercent,
    maxScore,
    matchedSpecs: matched,
    unmatchedSpecs
  };
}

module.exports = { evaluateSpecs };