async function extractVehicleDataFromPage(page) {
    const adData = await page.evaluate(() => window.UVL?.AD || null);
    if (!adData) throw new Error('Missing UVL.AD payload');

    const pageTitle = await page.title();

    const featureDescriptions = [
        ...(adData.features?.additional || []).map(f => f.description),
        ...(adData.features?.standard || []).map(f => f.description),
        ...(adData.features?.interior?.additional || []),
        ...(adData.features?.interior?.standard || []),
        ...(adData.features?.exterior?.additional || []),
        ...(adData.features?.exterior?.standard || [])
    ];

    return {
        id: adData.advert_id,
        title: pageTitle || 'BMW',
        url: await page.url(),
        engineFuel: adData.engine?.fuel || null,
        enginePower: adData.engine?.power?.value || null,
        engineSize: adData.engine?.size?.litres || null,
        mileage: adData.condition_and_state?.mileage || null,
        registration: adData.dates?.registration || null,
        manufacturedYear: adData.condition_and_state?.manufactured_year || null,
        batteryRange: adData.battery?.range?.value || null,
        co2: adData.consumption?.co2?.value || null,
        fuelType: adData.fuel_category || null,
        features: featureDescriptions
    };
}

module.exports = { extractVehicleDataFromPage };