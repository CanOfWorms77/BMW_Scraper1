const fs = require('fs');
const path = require('path');

const { captureAuditArtifacts } = require('./audit');

async function logAuditEntry({ auditPath, vehicleId, event = 'unspecified', error, details = {}, value, status }) {
    const logPath = path.join(auditPath, `${vehicleId}_audit.json`);
    const entry = {
        timestamp: new Date().toISOString(),
        vehicleId,
        event,
        error,
        value,
        status,
        ...details
    };

    try {
        await fs.promises.writeFile(logPath, JSON.stringify(entry, null, 2));
    } catch (err) {
        console.warn(`⚠️ Failed to write audit log for ${vehicleId}: ${err.message}`);
        // Optional fallback: append to a central log
        try {
            const fallbackPath = path.join(auditPath, `audit_fallback.json`);
            await fs.promises.appendFile(fallbackPath, JSON.stringify(entry) + '\n');
        } catch (fallbackErr) {
            console.warn(`⚠️ Fallback audit log also failed: ${fallbackErr.message}`);
        }
    }
}

function validatePayload(payload, vehicleId) {
    const requiredFields = {
        'advert_id': 'string',
/*        'dates.registration': 'string',
        'cash_price_value': 'number', // ✅ updated path
        'model_code': 'string',
        'condition_and_state.mileage': 'number',
        'dates.manufacture_year': 'number'*/
    };

    const issues = [];
    const fieldValues = {};

    function getNestedValue(obj, path) {
        return path.split('.').reduce((acc, key) => acc?.[key], obj);
    }

    for (const [path, expectedType] of Object.entries(requiredFields)) {
        let value = getNestedValue(payload, path);
        fieldValues[path] = value;

        if (value === undefined || value === null || value === '') {
            issues.push(`Missing or empty field: ${path}`);
        } else if (expectedType === 'number') {
            const num = Number(value);
            if (isNaN(num)) {
                issues.push(`Invalid number in field: ${path} (got "${value}")`);
            }
        } else if (expectedType === 'string') {
            if (typeof value !== 'string') {
                if (typeof value === 'number') {
                    value = String(value); // Coerce number to string
                } else {
                    issues.push(`Invalid type in field: ${path} (expected string, got ${typeof value})`);
                }
            }
        }
    }

    console.warn(`[${vehicleId}] Field values:`, fieldValues);

    const completeness = ((Object.keys(requiredFields).length - issues.length) / Object.keys(requiredFields).length * 100).toFixed(1);
    const valid = issues.length === 0;

    return { valid, issues, completeness };
}

async function validateAndLogPayload(adData, vehicleId, auditPath) {
    const { valid, issues, completeness } = validatePayload(adData, vehicleId);

    /*if (!valid) {
        console.warn(`[${vehicleId}] ❌ Payload validation failed`);
        issues.forEach((issue, i) => {
            console.warn(`[${vehicleId}] Issue ${i + 1}: ${issue}`);
        });

        const missingKeys = Object.keys(adData).filter(k => adData[k] === null || adData[k] === undefined);
        console.warn(`[${vehicleId}] Missing keys: ${missingKeys.join(', ')}`);
        
        await logAuditEntry({
            auditPath,
            vehicleId,
            event: 'Payload validation failed',
            error: 'Incomplete payload',
            details: { issues, missingKeys, completeness },
            value: adData,
            status: 'failure'
        });

        throw new Error(`Payload incomplete for ${vehicleId}`);
    }*/

    console.log(`[${vehicleId}] ✅ Payload validated successfully (${completeness}% complete)`);
}

async function parseVehicleContainer(container, selectors) {
    const regHandle = await container.$(selectors.registration);
    const regText = regHandle ? await regHandle.innerText() : null;
    const registration = regText?.trim();

    const linkHandle = await container.$(selectors.link);
    const href = linkHandle ? await linkHandle.getAttribute('href') : null;

    if (!registration || !href) return null;
    return { registration, href };
}

async function extractVehicleContainers(page, selectors) {
    return await page.locator(selectors.container).elementHandles();
}

async function auditMissingContainer(container, pageNumber, index, auditPath) {
    const html = await container.evaluate(el => el.outerHTML);
    const logPath = path.join(auditPath, 'missing_data.txt');
    fs.appendFileSync(logPath, `Page ${pageNumber}, Container ${index}:\n${html}\n\n`);
}

function auditSkippedRegistration(registration, pageNumber, index, auditPath) {
    const logPath = path.join(auditPath, 'skipped_registrations.txt');
    fs.appendFileSync(logPath, `Page ${pageNumber}, Index ${index}: ${registration}\n`);
}

async function auditPageHTML(page, selectors, pageNumber, auditPath) {
    const containerHTML = await page.locator(selectors.container).evaluateAll(elements =>
        elements.map(el => el.outerHTML)
    );
    const filePath = path.join(auditPath, `page_${pageNumber}_containers.html`);
    fs.writeFileSync(filePath, containerHTML.join('\n\n'));
}

async function auditShortPage(page, pageNumber, actualCount, expectedCount, auditPath) {
    const screenshotPath = path.join(auditPath, `short_page_${pageNumber}.png`);
    await page.screenshot({ path: screenshotPath });

    const logPath = path.join(auditPath, 'short_pages.txt');
    fs.appendFileSync(logPath, `Page ${pageNumber}: ${actualCount} listings (expected ${expectedCount})\n`);
}

async function preparePage(page) {
    await page.evaluate(() => new Promise(res => requestIdleCallback(res)));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.setViewportSize({ width: 1280, height: 800 });
}

async function auditScrollListeners(page, vehicleId) {
    try {
        const listeners = await page.evaluate(() =>
            (window.getEventListeners?.(window)?.scroll || []).map(l => l.listener?.toString())
        );
        console.log(`[${vehicleId}] Scroll listeners detected: ${listeners?.length}`);
    } catch (err) {
        console.warn(`[${vehicleId}] Could not inspect scroll listeners: ${err.message}`);
    }
}

async function hydrateUVLAD(page, vehicleId) {
    console.log(`[${vehicleId}] Waiting for UVL.AD hydration...`);
    const start = Date.now();

    await page.waitForFunction(() => {
        const ad = window.UVL?.AD;
        return ad?.advert_id && ad?.dates?.registration && ad?.condition_and_state?.mileage;
    }, {
        timeout: 15000,
        polling: 'mutation'
    });

    const hydrateDuration = Date.now() - start;
    console.log(`[${vehicleId}] UVL.AD hydrated in ${hydrateDuration}ms`);

    const adData = await Promise.race([
        page.evaluate(() => window.UVL?.AD || null),
        new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate() timeout')), 5000))
    ]);

    if (!adData || typeof adData !== 'object') {
        console.warn(`[${vehicleId}] ⚠️ hydrateUVLAD returned null or non-object`);
    } else {
        const keys = Object.keys(adData);
        console.log(`[${vehicleId}] adData keys: ${keys.join(', ')}`);

        if (keys.length < 5) {
            console.warn(`[${vehicleId}] ⚠️ adData appears sparse — only ${keys.length} keys`);
        }

        if (!adData.condition_and_state?.mileage) {
            console.warn(`[${vehicleId}] ⚠️ Missing mileage in adData.condition_and_state`);
        }

        if (!adData.dates?.registration) {
            console.warn(`[${vehicleId}] ⚠️ Missing registration date in adData.dates`);
        }
    }

    console.log(`[${vehicleId}] has_sold: ${adData.has_sold}`);
    console.log(`[${vehicleId}] uvl_flags:`, adData.uvl_flags);

    return adData;
}

function extractFeatures(adData, vehicleId = 'unknown') {
    try {
        const features = [
            ...(adData.features?.additional || []).map(f => f.description),
            ...(adData.features?.standard || []).map(f => f.description),
            ...(adData.features?.interior?.additional || []),
            ...(adData.features?.interior?.standard || []),
            ...(adData.features?.exterior?.additional || []),
            ...(adData.features?.exterior?.standard || [])
        ];
        console.log(`[${vehicleId}] Features extracted: ${features.length}`);
        return features;
    } catch (err) {
        console.warn(`[${vehicleId}] Failed to extract features: ${err.message}`);
        return [];
    }
}

async function extractTitle(page, vehicleId) {
    try {
        const title = await page.title();
        console.log(`[${vehicleId}] Page title: ${title}`);
        return title;
    } catch (err) {
        console.warn(`[${vehicleId}] Failed to extract title: ${err.message}`);
        return null;
    }
}

async function captureDOMSnapshot(page, auditPath, vehicleId, label = 'snapshot') {
    try {
        const html = await page.content();
        const filePath = path.join(auditPath, `${label}_dom_${vehicleId}.html`);
        fs.writeFileSync(filePath, html);
        console.log(`[${vehicleId}] DOM snapshot saved: ${label}`);
    } catch (err) {
        console.warn(`[${vehicleId}] Failed to write DOM snapshot: ${err.message}`);
    }
}

async function captureFailureArtifacts(page, auditPath, vehicleId, err) {
    const currentUrl = await page.url();
    const html = await page.content();

    fs.writeFileSync(path.join(auditPath, `dom_failure_${vehicleId}.html`), html);
    fs.appendFileSync(path.join(auditPath, 'context_state.txt'),
        `Vehicle: ${vehicleId}\nURL: ${currentUrl}\nError: ${err.message}\n\n`
    );

    try {
        await page.screenshot({ path: path.join(auditPath, `extractor_error_${vehicleId}.png`) });
    } catch (screenshotErr) {
        console.warn(`[${vehicleId}] Failed to capture error screenshot: ${screenshotErr.message}`);
    }
}

function buildVehicleObject(adData, title, features, url) {
    return {
        id: adData.advert_id,
        title: title || 'BMW',
        url,
        engineFuel: adData.engine?.fuel || null,
        enginePower: adData.engine?.power?.value || null,
        engineSize: adData.engine?.size?.litres || null,
        mileage: adData.condition_and_state?.mileage || null,
        registration: adData.dates?.registration || null,
        manufacturedYear: adData.condition_and_state?.manufactured_year || null,
        batteryRange: adData.battery?.range?.value || null,
        co2: adData.consumption?.co2?.value || null,
        fuelType: adData.fuel_category || null,
        features
    };
}

async function extractVehicleDataFromPage(page, vehicleId = 'unknown', auditPath, retryCount = 0, browser) {
    const start = Date.now();
    const context = page.context();

    console.log(`🧪 Starting extraction for ${vehicleId} (retry ${retryCount})`);
    if (!page || page.isClosed?.()) {
        throw new Error(`[${vehicleId}] Page is missing or closed — cannot extract`);
    }

    const url = await page.url();
    if (!url || !url.includes('/vehicle/')) {
        throw new Error(`[${vehicleId}] Page URL invalid or not navigated: ${url}`);
    }

    const content = await page.content();
    if (!content || content.length < 1000) {
        throw new Error(`[${vehicleId}] Page content too short — possible blank tab`);
    }

    await preparePage(page);
    await auditScrollListeners(page, vehicleId);
    await logAuditEntry({ auditPath, vehicleId, event: 'Waiting for UVL.AD' });

    let adData;
    try {
        const hydrateStart = Date.now();
        adData = await hydrateUVLAD(page, vehicleId);
        const hydrateDuration = Date.now() - hydrateStart;

        console.log(`[${vehicleId}] UVL.AD hydration took ${hydrateDuration}ms`);
        console.log(`[${vehicleId}] adData keys: ${Object.keys(adData || {}).join(', ')}`);

        if (!adData || typeof adData !== 'object' || Object.keys(adData).length === 0) {
            console.warn(`[${vehicleId}] ⚠️ hydrateUVLAD returned empty or invalid payload`);
        }

        /*const criticalFields = [
            'advert_id',
            'dates.registration',
            'cash_price.value',
            'model_code',
            'condition_and_state.mileage',
            'dates.manufacture_year'
        ];

        const missingCritical = criticalFields.filter(f => {
            const val = f.split('.').reduce((acc, key) => acc?.[key], adData);
            return val === undefined || val === null || val === '';
        });

        if (missingCritical.length > 0) {
            console.warn(`[${vehicleId}] ⚠️ Missing critical fields: ${missingCritical.join(', ')}`);
            console.log(`[${vehicleId}] Retrying hydration after short delay...`);
            await page.waitForTimeout(3000);
            adData = await hydrateUVLAD(page, vehicleId);
            console.log(`[${vehicleId}] Rehydrated adData keys: ${Object.keys(adData || {}).join(', ')}`);
        }

        // Patch known schema drift
        if (typeof adData.advert_id === 'number') {
            adData.advert_id = String(adData.advert_id);
            console.log(`[${vehicleId}] Coerced advert_id to string`);
        }

        if (adData.cash_price?.value !== undefined) {
            adData.cash_price = adData.cash_price.value;
            console.log(`[${vehicleId}] Extracted cash_price.value`);
        }

        if (!adData.dates?.manufacture_year && adData.dates?.registration) {
            const regYear = adData.dates.registration.match(/\b(20\d{2})\b/);
            if (regYear) {
                adData.dates.manufacture_year = Number(regYear[1]);
                console.log(`[${vehicleId}] Inferred manufacture_year from registration: ${regYear[1]}`);
            }
        }

        await captureDOMSnapshot(page, auditPath, vehicleId, retryCount > 0 ? `hydrated_retry${retryCount}` : 'hydrated');*/
    } catch (err) {
        await captureFailureArtifacts(page, auditPath, vehicleId, err);
        throw err;
    }

    /*try {
        await validateAndLogPayload(adData, vehicleId, auditPath);
    } catch (err) {
        await logAuditEntry({
            auditPath,
            vehicleId,
            event: `Retry ${retryCount + 1} triggered`,
            error: err.message,
            status: 'retry'
        });

        if (retryCount >= 2) {
            console.warn(`❌ Max retries reached for ${vehicleId}`);
            await logAuditEntry({
                auditPath,
                vehicleId,
                event: 'Max retries reached',
                error: 'Extraction failed after multiple attempts',
                status: 'failure'
            });
            return null;
        }

        console.log(`🔁 Retrying extraction for ${vehicleId}`);
        const retryDelay = 5000 + Math.floor(Math.random() * 3000);
        console.log(`⏳ Backing off for ${retryDelay}ms before retrying ${vehicleId}`);
        await page.waitForTimeout(retryDelay);

        if (!browser || typeof browser.newContext !== 'function' || browser.isConnected?.() === false) {
            console.warn(`[${vehicleId}] Browser disconnected — relaunching`);
            browser = await playwright.chromium.launch({ headless: true });
        }


        // 🔄 Recreate context and tab to avoid stale browser state
        if (!browser || typeof browser.newContext !== 'function' || browser.isConnected?.() === false) {
            throw new Error(`[${vehicleId}] Browser instance missing or disconnected during retry`);
        }

        if (!context.isClosed?.()) {
            await page.screenshot({ path: `${auditPath}/${vehicleId}_preRetry${retryCount}.png` });
            await context.close();
        }

        try {
            const freshContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            console.log(`[audit] New tab created — 9`);
            const freshPage = await freshContext.newPage();
            console.log(`[${vehicleId}] 🔄 Recreated browser context and tab for retry ${retryCount + 1}`);

            return await extractVehicleDataFromPage(freshPage, vehicleId, auditPath, retryCount + 1, browser);

        } catch (err) {

            await logAuditEntry({
                auditPath,
                vehicleId,
                event: `Retry ${retryCount} failed`,
                error: err.message,
                status: 'retry-failure'
            });

            throw err; // or return null if you're suppressing the error
        }
    } */

    let pageTitle, features, vehicle;
    try {
        console.log(`[${vehicleId}] Extracting title...`);
        pageTitle = await Promise.race([
            extractTitle(page, vehicleId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Title extraction timeout')), 5000))
        ]);
        console.log(`[${vehicleId}] Title extracted`);
    } catch (err) {
        await logAuditEntry({ auditPath, vehicleId, event: 'Title extraction failed', error: err.message });
        throw err;
    }

    try {
        console.log(`[${vehicleId}] Extracting features...`);
        features = extractFeatures(adData, vehicleId);
        console.log(`[${vehicleId}] Features extracted`);
    } catch (err) {
        await logAuditEntry({ auditPath, vehicleId, event: 'Feature extraction failed', error: err.message });
        throw err;
    }

    await logAuditEntry({ auditPath, vehicleId, event: 'Title extracted', value: pageTitle });
    await logAuditEntry({ auditPath, vehicleId, event: 'Mileage extracted', value: adData.condition_and_state?.mileage });

    if (process.env.AUDIT_SUCCESS === 'true') {
        try {
            await captureAuditArtifacts(page, vehicleId, auditPath);
        } catch (err) {
            await logAuditEntry({ auditPath, vehicleId, event: 'Audit artifact capture failed', error: err.message });
        }
    }

    try {
        await captureDOMSnapshot(page, auditPath, vehicleId, retryCount > 0 ? `final_retry${retryCount}` : 'final');
    } catch (err) {
        await logAuditEntry({ auditPath, vehicleId, event: 'Final DOM snapshot failed', error: err.message });
    }

    await logAuditEntry({ auditPath, vehicleId, event: 'Extraction complete', value: `${Date.now() - start}ms` });

    try {
        console.log(`[${vehicleId}] Fetching page URL...`);
        const pageUrl = await Promise.race([
            page.url(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('URL fetch timeout')), 5000))
        ]);
        console.log(`[${vehicleId}] Page URL: ${pageUrl}`);

        console.log(`[${vehicleId}] Building vehicle object...`);
        vehicle = buildVehicleObject(adData, pageTitle, features, pageUrl);
        console.log(`[${vehicleId}] Vehicle object built`);
    } catch (err) {
        await logAuditEntry({ auditPath, vehicleId, event: 'Vehicle build failed', error: err.message });
        throw err;
    }

    console.log(`[${vehicleId}] Returning extracted data`);
    return vehicle;
}

function ensureAuditPath(auditPath) {
    if (!auditPath || typeof auditPath !== 'string') {
        throw new Error(`Invalid auditPath: ${auditPath}`);
    }

    if (!fs.existsSync(auditPath)) {
        fs.mkdirSync(auditPath, { recursive: true });
    }
}

async function extractVehiclesFromPage(page, pageNumber, seenRegistrations, auditPath, auditMode, expectedPages, expectedCount, selectors) {
    ensureAuditPath(auditPath);

    const containers = await extractVehicleContainers(page, selectors);
    console.log(`🔍 Raw container count: ${containers.length}`);

    const vehiclesToProcess = [];

    for (let i = 0; i < containers.length; i++) {
        const container = containers[i];
        const parsed = await parseVehicleContainer(container, selectors);

        if (!parsed) {
            if (auditMode) await auditMissingContainer(container, pageNumber, i, auditPath);
            continue;
        }

        const { registration, href } = parsed;

        if (seenRegistrations.has(registration)) {
            console.log(`⏭️ Skipping already-seen registration: ${registration}`);
            if (auditMode) await auditSkippedRegistration(registration, pageNumber, i, auditPath);
            continue;
        }

        vehiclesToProcess.push({ registration, href, index: i });
    }

    if (auditMode) await auditPageHTML(page, selectors, pageNumber, auditPath);

    console.log(`✅ Vehicles to process: ${vehiclesToProcess.length}`);

    const expectedOnPage = (pageNumber < expectedPages) ? 23 : (expectedCount % 23 || 23);
    if (vehiclesToProcess.length < expectedOnPage) {
        await auditShortPage(page, pageNumber, vehiclesToProcess.length, expectedOnPage, auditPath);
    }

    console.log(`📊 Page ${pageNumber}: ${vehiclesToProcess.length} processed, ${seenRegistrations.size} skipped`);
    return vehiclesToProcess;
}

module.exports =
{
    extractVehiclesFromPage,
    extractVehicleDataFromPage,
    logAuditEntry
};
