// utils/modelSelectorTable.js
const modelSelectorTable = {
  'X5': {
    bodyStyleIndex: 4,
    skipBodyStyle: false,
    variant: '50e',
    modeltext: 'xDrive50e',
    seriesText: 'X'
  },
  '5 Series': {
    skipBodyStyle: true,
    variant: '550e',
    modeltext: '550e xDrive',
    seriesText: '5 Series'

  }
};

function getModelSelectorConfig(modelName) {
  return modelSelectorTable[modelName] || null;
}

module.exports = { getModelSelectorConfig };