// utils/modelSelectorTable.js
const modelSelectorTable = {
  'X5': {
    seriesIndex: 9,
    bodyStyleIndex: 4,
    skipBodyStyle: false,
    variant: '50e',
    modeltext: 'xDrive50e'
  },
  '5 Series': {
    seriesIndex: 4,
    skipBodyStyle: true,
    variant: '550e',
    modeltext: '550e xDrive'

  }
};

function getModelSelectorConfig(modelName) {
  return modelSelectorTable[modelName] || null;
}

module.exports = { getModelSelectorConfig };