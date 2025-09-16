const fs = require('fs');
const path = require('path');

const { captureAuditArtifacts } = require('./audit');

async function extractVehicleDataFromPage(page, vehicleId = 'unknown', auditPath) {
    const start = Date.now();

    try {
        // Wait for UVL.AD payload to be available
        await page.waitForFunction(() => window.UVL?.AD, { timeout: 5000 });

        // Extract payload
        const adData = await page.evaluate(() => window.UVL?.AD || null);
        const loadTime = Date.now() - start;
        console.log(`⏱️ UVL.AD extraction took ${loadTime}ms`);

        if (!adData) {
            throw new Error('Missing UVL.AD payload');
        }

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
    } catch (err) {
        console.warn(`❌ Extraction failed for ${vehicleId}: ${err.message}`);

        await captureAuditArtifacts(page, vehicleId, auditPath, err);

        throw err;
    }
}

async function extractVehiclesFromPage(page, pageNumber, seenRegistrations, auditPath, auditMode, expectedPages, expectedCount, selectors) {
    const containers = await page.locator(selectors.container).elementHandles();
    const vehiclesToProcess = [];

    console.log(`🔍 Raw container count: ${containers.length}`);

    for (let i = 0; i < containers.length; i++) {
        const container = containers[i];

        const regHandle = await container.$(selectors.registration);
        const regText = regHandle ? await regHandle.innerText() : null;
        const registration = regText?.trim();

        const linkHandle = await container.$(selectors.link);
        const href = linkHandle ? await linkHandle.getAttribute('href') : null;

        if (!registration || !href) {
            if (auditMode) {
                const html = await container.evaluate(el => el.outerHTML);
                fs.appendFileSync(path.join(auditPath, 'missing_data.txt'), `Page ${pageNumber}, Container ${i}:\n${html}\n\n`);
            }
            continue;
        }

        if (seenRegistrations.has(registration)) {
            console.log(`⏭️ Skipping already-seen registration: ${registration}`);
            if (auditMode) {
                fs.appendFileSync(path.join(auditPath, 'skipped_registrations.txt'), `Page ${pageNumber}, Index ${i}: ${registration}\n`);
            }
            continue;
        }

        vehiclesToProcess.push({ registration, href, index: i });
    }

    if (auditMode) {
        const containerHTML = await page.locator(selectors.container).evaluateAll(elements =>
            elements.map(el => el.outerHTML)
        );
        fs.writeFileSync(path.join(auditPath, `page_${pageNumber}_containers.html`), containerHTML.join('\n\n'));
    }

    console.log(`✅ Vehicles to process: ${vehiclesToProcess.length}`);

    if (vehiclesToProcess.length > 0) {
        const expectedOnPage = (pageNumber < expectedPages) ? 23 : (expectedCount % 23 || 23);
        if (vehiclesToProcess.length < expectedOnPage) {
            console.warn(`⚠️ Page ${pageNumber} has only ${vehiclesToProcess.length} listings — expected ${expectedOnPage}`);
            fs.appendFileSync(path.join(auditPath, 'short_pages.txt'), `Page ${pageNumber}: ${vehiclesToProcess.length} listings (expected ${expectedOnPage})\n`);
        }
    }

    return vehiclesToProcess;
}

module.exports =
{
    extractVehiclesFromPage,
    extractVehicleDataFromPage
};
