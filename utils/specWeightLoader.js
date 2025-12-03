const specWeightTables = {
    'X5': {
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
    },
    '5 Series':{
        "Technology Plus Pack": 4,
        "Comfort Plus Pack": 4,
        "M Sport Pro Pack": 2,
        "Panoramic": 4,
        "M Adaptive Suspension": 4,
        "Adaptive M Suspension Professional": 4,
        "Driving Assistant Professional": 3,
        "Bowers & Wilkins": 4,
        "Black extended Merino leather": 3,
        "M Multifunctional Seats": 4,
        "M Carbon Exterior Package": 3,
        "Crafted Clarity": 1,
        "Travel and Comfort System": 2,
        "M Sport brake, red high-gloss": 3,
        "red calipers": 3,
        "Sun Protection Glass": 2,
    },
    'i4': {
        "Technology Plus Pack": 4,
        "Comfort Plus Pack": 4,
        "Harman/Kardon": 4,
        "Carbon Fibre Interior Trim": 3,
        "M Sport Pro Pack": 2,
        "Sunroof": 4,
        "M Adaptive Suspension": 3,
        "Driving Assistant Professional": 3,
        "M Sport Brakes with Red Calipers": 3,
        "Sun Protection Glass": 2,
    }
   };


    function getSpecWeights(modelName) {
  return specWeightTables[modelName] || specWeightTables.default;
}

module.exports = { getSpecWeights };

