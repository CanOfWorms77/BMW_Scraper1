
// chunk-1.js
require('dotenv').config();
const { chromium } = require('playwright');
const { evaluateSpecs } = require('./utils/specEvaluator');
const { sendEmail } = require('./utils/emailSender');
const { extractVehiclesFromPage, extractVehicleDataFromPage, logAuditEntry } = require('./utils/vehicleExtractor');
const { loadJSON, saveJSON } = require('./utils/file_manager');
const fs = require('fs');

const dryRun = process.argv.includes('--dry');
const verboseMode = process.argv.includes('--verbose');
const auditMode = process.argv.includes('--audit');
const maxPagesArg = process.argv.find(arg => arg.startsWith('--max-pages='));
const maxPages = maxPagesArg ? parseInt(maxPagesArg.split('=')[1], 10) : Infinity;

const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const { getModelSelectorConfig } = require('./utils/modelSelectorTable');
const { captureAuditArtifacts } = require('./utils/audit');


const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const rawDetailsPath = path.resolve('audit', `raw_details_${timestamp}.txt`);

const argv = yargs(hideBin(process.argv)).argv;

const models = ['X5', '5 Series', 'i4'];
const modelIndex = parseInt(process.env.MODEL_INDEX || '0', 10);
const currentModel = models[modelIndex] || 'X5'; // fallback if index is out of bounds

const safeModelFolder = currentModel.replace(/\s+/g, '_'); // e.g. "5 Series" → "5_Series"
const auditPath = path.resolve(process.cwd(), 'audit', safeModelFolder);

const selectorMap = require('./utils/selectors');
const selectors = selectorMap[currentModel] || selectorMap['X5'];
if (!selectors) {
    throw new Error(`❌ No selectors defined for model: ${currentModel}`);
}

const seenPath = path.join('data', `seen_vehicles_${currentModel.replace(/\s+/g, '_')}.json`);
const seenRegPath = path.join('data', `seen_registrations_${currentModel.replace(/\s+/g, '_')}.json`);


console.log(`🔍 MODEL_INDEX=${process.env.MODEL_INDEX}, currentModel=${currentModel}`);

if (!auditPath || typeof auditPath !== 'string') {
    throw new Error(`Invalid auditPath: ${auditPath}`);
}

if (!fs.existsSync(auditPath)) {
    fs.mkdirSync(auditPath, { recursive: true });
}

const retryCount = parseInt(process.env.RETRY_COUNT || '0');
if (retryCount >= 3) {
    console.error('🛑 Max retries reached. Aborting.');
    fs.appendFileSync(path.join(auditPath, 'restart_log.txt'),
        `${new Date().toISOString()} — Aborted after ${retryCount} retries\n`);
    process.exit(1);
}

async function safeGoto(context, page, url, vehicleId = 'unknown', auditPath, retries = 3) {
    console.log(`[${vehicleId}] Entering safeGoto`);
    console.log(`[${vehicleId}] Received URL: ${url}`);

    const cleanUrl = url.split('?')[0];

    for (let i = 0; i < retries; i++) {
        try {

            if (!page || typeof page.goto !== 'function') {
                throw new Error(`[${vehicleId}] Invalid page object passed to safeGoto`);
            }
            
            if (!cleanUrl || cleanUrl === 'about:blank') {
                console.warn(`[${vehicleId}] Skipping navigation — URL is blank or invalid: ${cleanUrl}`);
                await page.screenshot({ path: path.join(auditPath, `invalid_url_${vehicleId}.png`) });
                await page.close(); // 🔒 Clean up the tab
                continue; // ⏭️ Skip to next retry or vehicle
            } else {

                await page.screenshot({ path: path.join(auditPath, `pre_goto_${vehicleId}.png`) });

                const navStart = Date.now();
                const response = await page.goto(cleanUrl, {
                    waitUntil: 'networkidle',
                    timeout: 30000
                });
                const navEnd = Date.now();

                console.log(`[${vehicleId}] Navigation took ${navEnd - navStart}ms`);
                console.log(`[${vehicleId}] Tab isClosed: ${page.isClosed?.()}`);

                await page.screenshot({ path: path.join(auditPath, `post_goto_${vehicleId}.png`) });

                const landedUrl = await page.url();
                console.log(`[${vehicleId}] Landed on URL: ${landedUrl}`);

                if (landedUrl === 'about:blank') {
                    console.warn(`[${vehicleId}] Navigation failed — tab remained blank`);
                    await page.screenshot({ path: path.join(auditPath, `blank_tab_${vehicleId}.png`) });
                    await page.close();
                    continue; // skip to next retry
                }

                console.log(`[${vehicleId}] Navigation response status: ${response?.status?.()}`);
            }

            if (!auditPath || typeof auditPath !== 'string') {
                throw new Error(`Invalid auditPath for ${vehicleId}`);
            }

            await page.waitForTimeout(3000); // Let scripts initialize

            try {
                await page.click('button:has-text("Reject")', { timeout: 3000 });
                console.log(`✅ Cookies rejected for ${vehicleId}`);
                await page.waitForTimeout(1000);

                // Forensic snapshot before selector wait
                await page.screenshot({ path: path.join(auditPath, 'pre_series_wait.png') });

                // Dump raw HTML for inspection
                fs.writeFileSync(path.join(auditPath, 'pre_series_dom.html'), await page.content());

                // Log timestamped marker
                fs.appendFileSync(path.join(auditPath, 'pre_series_marker.txt'),
                    `${new Date().toISOString()} — Reached cookie rejection, preparing to wait for #series\n`);

            } catch {
                console.log(`⚠️ No cookie modal found for ${vehicleId} — continuing`);
            }

            await page.screenshot({ path: path.join(auditPath, `post_cookie_${vehicleId}.png`) });


            /*if (!response || !response.ok()) {
                const status = response?.status?.() ?? 'unknown';
                console.warn(`⚠️ Navigation failed: ${status} — ${url}`);
                fs.appendFileSync(path.join(auditPath, 'bad_responses.txt'),
                    `Vehicle ID: ${vehicleId}, Status: ${status} — ${url}\n`);
                continue;
            }*/

            await page.addStyleTag({
                content: `
                *, *::before, *::after {
                    transition: none !important;
                    animation: none !important;
                }
            `
            });

            await page.evaluate(() => window.scrollTo(0, 0));

            try {
                const listeners = await page.evaluate(() =>
                    (window.getEventListeners?.(window)?.scroll || []).map(l => l.listener?.toString())
                );
                if (listeners?.length) {
                    console.log(`[${vehicleId}] Scroll listeners detected:`, listeners.length);
                }
            } catch (err) {
                console.warn(`[${vehicleId}] Could not inspect scroll listeners: ${err.message}`);
            }

            await page.screenshot({ path: path.join(auditPath, `vehicle_load_${vehicleId}.png`) });

            const content = await page.content();
            if (!content || content.length < 1000) {
                console.warn(`⚠️ Page content too short — possible blank page: ${url}`);
                fs.writeFileSync(path.join(auditPath, `blank_vehicle_${vehicleId}.html`), content);
                await page.screenshot({ path: path.join(auditPath, `blank_vehicle_${vehicleId}.png`) });
                continue;
            }

            const adCheck = await page.evaluate(() => window.UVL?.AD || null);
            fs.writeFileSync(path.join(auditPath, `ad_check_${vehicleId}.json`), JSON.stringify(adCheck, null, 2));

            return page; // ✅ Always return the final tab
        } catch (err) {
            console.warn(`⚠️ Retry ${i + 1} failed for ${url}: ${err.message}`);
            await new Promise(res => setTimeout(res, 1500));
        }
    }

    console.log(`[${vehicleId}] Exiting safeGoto`);
    throw new Error(`❌ Failed to load ${url} after ${retries} attempts`);
}

async function setupBrowser() {
    const isCI = process.env.CI === 'true';
    const headless = isCI || process.argv.includes('--headless');
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    if (auditMode && !fs.existsSync('audit')) {
        fs.mkdirSync('audit');
    }

    return { browser, context, page };
}

async function navigateAndFilter(page, currentModel, auditPath) {

    if (!auditPath || typeof auditPath !== 'string') {
    throw new Error(`Invalid auditPath: ${auditPath}`);
    }

    if (!fs.existsSync(auditPath)) {
    fs.mkdirSync(auditPath, { recursive: true });
    }

    console.log(`🌐 Navigating to BMW Approved Used site for ${currentModel}...`);
    const modelConfig = getModelSelectorConfig(currentModel);
    if (!modelConfig) throw new Error(`❌ No selector config found for model: ${currentModel}`);

    await page.goto('https://usedcars.bmw.co.uk/');
    await page.click('button:has-text("Reject")');
    console.log('✅ Cookies rejected');
    await page.waitForTimeout(1000);

    await page.screenshot({ path: path.join(auditPath, 'failure_before_series.png') });

    // Select Series
 /*   await page.waitForSelector('#series', { timeout: 60000 });
    await page.click('#series');
    await page.waitForTimeout(1200);*/

    await page.waitForSelector('#series .uvl-c-react-select__control', { timeout: 60000 });
    await page.click('#series .uvl-c-react-select__control');
    await page.waitForSelector('.uvl-c-react-select__option', { timeout: 5000 });

    const options = await page.$$('.uvl-c-react-select__option');
    let matched = false;

    for (const option of options) {
        const text = await option.textContent();
        console.log(`text "${text}"`);
        if (text?.trim() === modelConfig.seriesText) {
            await option.click();
            matched = true;
            break;
        }
    }


    if (!matched) {
        throw new Error(`Series text "${modelConfig.seriesText}" not found in dropdown`);
    }

    console.log(`✅ Selected series "${modelConfig.seriesText}" for ${currentModel}`);

    if (!auditPath || typeof auditPath !== 'string') {
        throw new Error(`Invalid auditPath: ${auditPath}`);
    }

    // Select Body Style (if applicable)
    if (!modelConfig.skipBodyStyle) {
    await page.waitForSelector('#body_style', { timeout: 60000 });
    await page.click('#body_style');
    await page.waitForTimeout(1200);
    for (let i = 0; i < modelConfig.bodyStyleIndex; i++) await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(700);
    await page.keyboard.press('Enter');
    console.log(`✅ Selected body style`);
    } else {
    console.log(`⏭️ Skipping body style for ${currentModel}`);
    fs.appendFileSync(path.join(auditPath, 'skipped_body_style.txt'),
        `${new Date().toISOString()} — Skipped body style for ${currentModel}\n`);
    }

    // Trigger initial search to load filters
    await page.click('button.uvl-c-expected-results-btn');
    console.log('✅ Search button clicked');

    // Open variant filter section
    await page.click('button[data-tracking-effect="Additional filters"]');
    await page.locator('a.rc-collapse-header:has-text("Model variant")').click();

    await page.waitForTimeout(1200);

    // Open engine derivatives dropdown
    const engineDropdown = page.locator('span.uvl-c-select__placeholder', {
    hasText: 'Engine derivatives'
    });
    await engineDropdown.waitFor({ state: 'visible', timeout: 10000 });
    await engineDropdown.click();
    console.log('✅ Engine derivatives dropdown clicked');

    await page.waitForTimeout(1200);

    // Scroll dropdown to bottom
    await page.waitForSelector('#react-select-7-listbox', { timeout: 10000 });
    await page.evaluate(() => {
    const menu = document.querySelector('#react-select-7-listbox');
    if (menu) menu.scrollTop = menu.scrollHeight;
    });
    await page.waitForTimeout(2200);

    // Locate variant option by text
    const variantOption = page.locator('#variant .react-select-option:has-text("' + modelConfig.variant + '")');

    try {
    await variantOption.waitFor({ state: 'visible', timeout: 10000 });
    await variantOption.click();
    console.log(`✅ Variant "${modelConfig.variant}" selected`);
    } catch (err) {
    console.warn(`⚠️ First attempt to select "${modelConfig.variant}" failed — retrying...`);
    await page.waitForTimeout(2000);
    try {
        await variantOption.click();
        console.log(`✅ Variant "${modelConfig.variant}" selected on retry`);
    } catch (finalErr) {
        const msg = `❌ Variant "${modelConfig.variant}" failed twice — aborting model`;
        console.warn(msg);

        if (!auditPath || typeof auditPath !== 'string') {
            throw new Error(`Invalid auditPath: ${auditPath}`);
        }

        fs.appendFileSync(path.join(auditPath, 'variant_failure.txt'),
        `${new Date().toISOString()} — ${msg}\n`);
        throw new Error(msg);
    }
    }

    if (!auditPath || typeof auditPath !== 'string') {
        throw new Error(`Invalid auditPath: ${auditPath}`);
    }

    // Confirm hidden input was updated
    await page.waitForTimeout(1000);
    const selectedVariant = await page.getAttribute('input[name="variant"]', 'value');
    if (!selectedVariant || selectedVariant.trim() === '') {
    const msg = `❌ Variant "${modelConfig.variant}" click registered but not committed`;
    console.warn(msg);
    fs.appendFileSync(path.join(auditPath, 'variant_commit_failure.txt'),
        `${new Date().toISOString()} — ${msg}\n`);
    throw new Error(msg);
    }
    console.log(`🔍 Variant input value confirmed: ${selectedVariant}`);

    // Final search and listing wait
    await page.waitForTimeout(1500);
    await page.click('button.uvl-c-expected-results-btn');
    console.log('✅ Final search triggered with engine derivative');

    await page.waitForTimeout(3000);
    await page.waitForSelector('a.uvl-c-advert__media-link[href*="/vehicle/"]', { timeout: 15000 });
    console.log('✅ Listings loaded');

    const modelNameText = await page.locator('img.uvl-c-advert__media-image').evaluateAll(nodes =>
        nodes.map(n => n.getAttribute('alt') || ''));
    const expectedText = modelConfig.modeltext.toLowerCase();
    console.log("${expectedText}");

    const matchedModelText = modelNameText.find(alt => alt.toLowerCase().includes(expectedText));

    if (!matchedModelText) {
        const msg = `❌ No image alt text contains "${matchedModelText}"`;
        console.warn(msg);
        fs.appendFileSync(path.join(auditPath, 'model_text_mismatch.txt'),
            `${new Date().toISOString()} — ${msg}\n`);
        throw new Error(msg);
    }
    else {
        console.log(`✅ Found matching model text: "${matchedModelText}"`);
    }
}

async function parseExpectedCount(page) {
    const buttonText = await page.locator('button.uvl-c-expected-results-btn').innerText();
    console.log(`🔍 Raw button text: "${buttonText}"`);
    const match = buttonText.match(/(\d{2,4})\s*available/i);
    if (!match) {
        console.warn(`⚠️ Could not parse expected vehicle count from button text`);
        return null;
    }
    const expectedCount = parseInt(match[1], 10);
    console.log(`📊 Parsed expected vehicle count: ${expectedCount}`);
    return expectedCount;
}

async function attemptPaginationAdvance(page, nextButton, auditPath, pageNumber) {
    const currentUrl = await page.url();

    if (!auditPath || typeof auditPath !== 'string') {
        throw new Error(`Invalid auditPath: ${auditPath}`);
    }

    if (!fs.existsSync(auditPath)) {
        fs.mkdirSync(auditPath, { recursive: true });
    }

    try {
        await nextButton.click({ force: true });
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);
    } catch (err) {
        console.warn(`⚠️ Initial pagination click failed: ${err.message}`);
        return false;
    }

    const newUrl = await page.url();
    if (newUrl === currentUrl) {
        await page.screenshot({
            path: path.join(auditPath, `pagination_failure_page_${pageNumber}.png`)
        });
        console.warn('⚠️ Pagination did not advance — retrying...');
        try {
            await nextButton.click({ force: true });
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(2000);
        } catch (err) {
            console.warn(`❌ Retry click failed: ${err.message}`);
            return false;
        }

        if ((await page.url()) === currentUrl) {
            console.warn('❌ Still stuck — breaking pagination');
            return false;
        }
    }

    return true;
}

async function scrapePage(page, detailPage, context, browser,{
    pageNumber,
    expectedPages,
    expectedCount,
    seen,
    seenVehicles,
    results,
    seenRegistrations,
    currentModel,
    auditPath
}) {
    console.log(`[scrapePage] ENTER page ${pageNumber}`);
    const scrapeStart = Date.now();

    const vehiclesToProcess = await extractVehiclesFromPage(
        page,
        pageNumber,
        seenRegistrations,
        auditPath,
        auditMode,
        expectedPages,
        expectedCount,
        selectors
    );

    console.log(`✅ Extracted ${vehiclesToProcess.length} vehicles`);


    if (vehiclesToProcess.length === 0) {
        console.log(`⏩ No vehicles to process on page ${pageNumber}. Closing tab`);
        await detailPage.close(); // 🔒 Clean up the tab
    } else {
        for (let i = 0; i < vehiclesToProcess.length; i++) {
            const { registration, href } = vehiclesToProcess[i];
            const fullUrl = new URL(href, 'https://usedcars.bmw.co.uk').toString();
            const vehicleIdMatch = fullUrl.match(/vehicle\/([^?]+)/);
            const vehicleId = vehicleIdMatch ? vehicleIdMatch[1].trim() : `unknown-${Date.now()}`;

            seenVehicles.set(vehicleId, { page: pageNumber, index: i, link: fullUrl });
            console.log(`🔍 Extracting data from: ${fullUrl}`);

            if (context.isClosed?.()) {
                console.warn(`⚠️ Context was closed before vehicle ${vehicleId}. Recreating...`);
                context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            }

            let start = Date.now();
            try {
                /*if (detailPage && !detailPage.isClosed()) {
                    await detailPage.close();
                    console.log(`Here`);
                }*/

                detailPage = await safeGoto(context, detailPage, fullUrl, vehicleId, auditPath);

                /*const blankCheckSelector = 'div.vehicle-details, .vehicle-header, .main-content'; // tune as needed
                const isBlank = await detailPage.evaluate((selector) => {
                    const el = document.querySelector(selector);
                    return !el || el.innerText.trim().length === 0;
                }, blankCheckSelector);

                if (isBlank) {
                    console.warn(`[${vehicleId}] ❌ Blank page detected — skipping extraction`);
                    fs.appendFileSync(path.join(auditPath, 'blank_pages.txt'),
                        `Vehicle ID: ${vehicleId}, URL: ${fullUrl} — blank page detected\n`);
                    await detailPage.screenshot({ path: path.join(auditPath, `blank_page_${vehicleId}.png`) });
                    continue;
                }*/

                const loadTime = Date.now() - start;
                console.log(`⏱️ Page load took ${loadTime}ms`);
            } catch (err) {
                console.error(`❌ safeGoto threw an error for ${fullUrl}:`, err.message);
                fs.appendFileSync(path.join(auditPath, 'safeGoto_errors.txt'),
                    `Vehicle ID: ${vehicleId}, Error: ${err.message} — ${fullUrl}\n`);
                continue;
            }

            let vehicleData;
            let extractionFailed = false;

            try {
                const timeoutMs = 30000;
                console.log(`⏱️ Timeout for ${vehicleId} set to ${timeoutMs}ms`);

                await detailPage.screenshot({ path: path.join(auditPath, `extractor_main_entry_${vehicleId}.png`) });
                console.log(`[${vehicleId}] Starting main extraction`);

                try {
                    vehicleData = await Promise.race([
                        extractVehicleDataFromPage(detailPage, vehicleId, auditPath, 0, browser),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error(`[${vehicleId}] ⏱️ Extraction timeout after ${timeoutMs}ms`)), timeoutMs)
                        )
                    ]);

                    const delayMs = 3000 + Math.floor(Math.random() * 2000);
                    console.log(`⏳ Sleeping for ${delayMs}ms before next vehicle...`);
                    await detailPage.waitForTimeout(delayMs);

                } catch (innerErr) {
                    extractionFailed = true;
                    console.warn(`⚠️ Extraction error for ${vehicleId}: ${innerErr.message}`);

                    fs.appendFileSync(path.join(auditPath, 'extraction_failures.txt'),
                        `Vehicle ID: ${vehicleId}, Error: ${innerErr.message}\n`);

                    try {
                        const html = await detailPage.content();
                        const domPath = path.join(auditPath, `timeout_dom_${vehicleId}.html`);
                        const shotPath = path.join(auditPath, `timeout_dom_${vehicleId}.png`);

                        fs.writeFileSync(domPath, html);
                        await detailPage.screenshot({ path: shotPath });

                        console.log(`[${vehicleId}] Timeout DOM snapshot saved: ${path.basename(domPath)}`);
                    } catch (domErr) {
                        console.warn(`[${vehicleId}] Failed to capture timeout DOM: ${domErr.message}`);
                    }
                }
            } catch (outerErr) {
                console.error(`❌ Fatal extraction failure for ${vehicleId}: ${outerErr.message}`);
                extractionFailed = true;
            }

            if (extractionFailed || !vehicleData || Object.keys(vehicleData).length === 0) {
                console.warn(`🔁 Retrying with fresh context for ${vehicleId}`);
                const retryStart = Date.now();

                if (detailPage && !detailPage.isClosed()) {
                    await detailPage.close();
                }

                if (context.isClosed?.()) {
                    console.warn('⚠️ Context closed — recreating');
                    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
                } else {
                    await context.close();
                    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
                    console.log(`🔄 Context recreated after retry for ${vehicleId}`);
                }
                if (detailPage && !detailPage.isClosed()) {
                    await detailPage.close();
                }
                console.log(`[audit] New tab created 4`);
                detailPage = await context.newPage();
                await detailPage.setViewportSize({ width: 1280, height: 800 });

                detailPage = await safeGoto(context, detailPage, fullUrl, vehicleId, auditPath);

                /*const blankCheckSelector = 'div.vehicle-details, .vehicle-header, .main-content'; // tune as needed
                const isBlank = await detailPage.evaluate((selector) => {
                    const el = document.querySelector(selector);
                    return !el || el.innerText.trim().length === 0;
                }, blankCheckSelector);

                if (isBlank) {
                    console.warn(`[${vehicleId}] ❌ Blank page detected — skipping extraction`);
                    fs.appendFileSync(path.join(auditPath, 'blank_pages.txt'),
                        `Vehicle ID: ${vehicleId}, URL: ${fullUrl} — blank page detected\n`);
                    await detailPage.screenshot({ path: path.join(auditPath, `blank_page_${vehicleId}.png`) });
                    continue;
                }
                */

                console.log(`[${vehicleId}] Starting data extraction`);
                await detailPage.screenshot({ path: path.join(auditPath, `extractor_entry_${vehicleId}.png`) });

                vehicleData = await Promise.race([
                    extractVehicleDataFromPage(detailPage, vehicleId, auditPath, 0, browser),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`[${vehicleId}] Extractor hard timeout after 20000ms`)), 20000)
                    )
                ]);

                const retryDuration = Date.now() - retryStart;
                console.log(`⏱️ Retry for ${vehicleId} took ${retryDuration}ms`);

                if (!vehicleData || Object.keys(vehicleData).length === 0) {
                    throw new Error(`Retry failed for ${vehicleId}`);
                }

                extractionFailed = false;
            }

            vehicleData.id = vehicleId;
            vehicleData.registration = registration;
            seen.add(vehicleId);
            seenRegistrations.add(registration);

            if (auditMode) {
                fs.appendFileSync(path.join(auditPath, 'raw_vehicle_data.txt'),
                    JSON.stringify({ url: fullUrl, data: vehicleData }, null, 2) + '\n\n');
            }

            const enriched = evaluateSpecs(vehicleData, currentModel);
            enriched.timestamp = new Date().toISOString();
            results.push(enriched);

            if (auditMode && rawDetailsPath) {
                fs.appendFileSync(rawDetailsPath, `Page ${pageNumber} — ${vehicleData.title || 'Untitled'}\n`);
                fs.appendFileSync(rawDetailsPath, JSON.stringify(vehicleData, null, 2) + '\n\n');
            }

            await new Promise(res => setTimeout(res, 1500));
            if (results.length % 25 === 0) {
                await detailPage.close();
                console.log(`[audit] New tab created 5`);
                detailPage = await context.newPage();
                await detailPage.setViewportSize({ width: 1280, height: 800 });
                console.log(`🔄 Detail page reset after ${results.length} vehicles`);
            }
        }
    }

    if (!auditPath || typeof auditPath !== 'string') {
        throw new Error(`Invalid auditPath for ${pageNumber}`);
    }

    // 📸 Final audit snapshot
    if (auditMode && detailPage && !detailPage.isClosed?.()) {
        try {
            console.log(`[scrapePage] Capturing fail_page_${pageNumber}_dom.html`);
            const html = await detailPage.content();
            fs.writeFileSync(path.join(auditPath, `fail_page_${pageNumber}_dom.html`), html);
        } catch (err) {
            console.warn(`[scrapePage] Failed to capture detailPage DOM: ${err.message}`);
        }
    } else {
        console.warn(`[scrapePage] Skipped DOM dump — detailPage was closed`);
    }

    if (page && !page.isClosed?.()) {
        try {
            const html = await page.content();
            fs.writeFileSync(path.join(auditPath, `page_${pageNumber}_dom.html`), html);
        } catch (err) {
            console.warn(`[scrapePage] Failed to capture page DOM: ${err.message}`);
        }
    }

    // 🔍 Pagination audit
    const nextButton = page.locator('a.uvl-c-pagination__direction--next[aria-label="Next page"]');
    const nextVisible = await nextButton.isVisible();
    const ariaDisabled = await nextButton.getAttribute('aria-disabled');
    const hiddenLabel = await nextButton.locator('.visually-hidden').textContent();
    const trackingAction = await nextButton.getAttribute('data-tracking-action');

    console.log(`🔍 Next button found: ${await nextButton.count()}`);
    console.log(`🔍 Next button visible: ${nextVisible}`);
    console.log(`🔍 aria-disabled: ${ariaDisabled}`);
    console.log(`🔍 Hidden label: ${hiddenLabel?.trim()}`);
    console.log(`🔍 Tracking action: ${trackingAction}`);
    console.log(`🔍 Current page URL: ${await page.url()}`);

    const paginationAudit = {
        pageNumber,
        url: await page.url(),
        nextButtonVisible: nextVisible,
        ariaDisabled,
        hiddenLabel: hiddenLabel?.trim(),
        trackingAction
    };

    fs.writeFileSync(
        path.join(auditPath, `page_${pageNumber}_pagination.json`),
        JSON.stringify(paginationAudit, null, 2)
    );

    // ➡️ Determine if pagination should continue
    let hasNextPage = nextVisible && ariaDisabled === 'false';

    if (hasNextPage) {
        hasNextPage = await attemptPaginationAdvance(page, nextButton, auditPath, pageNumber);
        if (hasNextPage) {
            console.log(`➡️ Pagination advanced to page ${pageNumber + 1}`);
        }
    }

    if (!hasNextPage || (expectedPages && pageNumber >= expectedPages)) {
        console.log(`🛑 Final page reached — no further pagination attempted`);
        hasNextPage = false;
    }

    fs.appendFileSync(path.join(auditPath, 'pagination_log.txt'),
        `Page ${pageNumber} — URL: ${await page.url()}\n`);

    const scrapeDuration = Date.now() - scrapeStart;
    console.log(`[scrapePage] Duration: ${scrapeDuration}ms`);
    console.log(`[scrapePage] Completed page ${pageNumber} with ${results.length} results`);
    console.log(`[scrapePage] EXIT page ${pageNumber}`);

    const mem = process.memoryUsage();
    console.log(`[scrapePage] Memory used: RSS ${Math.round(mem.rss / 1024 / 1024)}MB`);

    return { hasNextPage };
}

async function finaliseRun({ seen, results = [], seenVehicles, expectedCount, currentModel, auditPath }) {
    const modelSafe = currentModel.replace(/\s+/g, '_');
    const dataDir = path.resolve('data');

    const seenPath = path.join(dataDir, `seen_vehicles_${modelSafe}.json`);
    const skippedPath = path.join(dataDir, `skipped_ids_${modelSafe}.txt`);
    const alertsPath = path.join(dataDir, `alerts_${modelSafe}.txt`);
    const outputPath = path.join(dataDir, `output_${modelSafe}.json`);
    const missingPath = path.join(dataDir, `missing_vehicles_${modelSafe}.txt`);
    const duplicatesPath = path.join(dataDir, `duplicates_${modelSafe}.txt`);

    try {
        saveJSON(seenPath, Array.from(seen).map(id => id.split('?')[0].trim()));
    } catch (err) {
        console.error(`❌ Failed to save seen vehicles: ${err.message}`);
    }

    try {
        fs.writeFileSync(skippedPath, Array.from(seen)
            .filter(id => !results.find(v => v.id === id))
            .join('\n'));
    } catch (err) {
        console.error(`❌ Failed to write skipped IDs: ${err.message}`);
    }

    console.log(`✅ Total vehicles assessed this run: ${results.length}`);
    console.log(`📦 Total vehicles ever seen: ${seen.size}`);
    console.log(`⏩ Skipped as already seen: ${seen.size - results.length}`);
    console.log(`🕒 Run completed at: ${new Date().toLocaleString()}`);

    if (results.length > 0) {
        const sorted = results.sort((a, b) => b.scorePercent - a.scorePercent);
        const lines = sorted.map(v => `• ${v.title} — ${v.scorePercent}% match\n${v.url}`).join('\n\n');
        const subject = `🚗 BMW Digest: ${sorted.length} vehicles assessed`;
        const body = `Here are the top matches:\n\n${lines}`;

        if (!dryRun) {
            try {
                if (verboseMode) console.log('📤 Attempting to send email...');
                await sendEmail({ subject, body });
                console.log(`📧 Sent digest with ${sorted.length} vehicles`);
            } catch (err) {
                console.warn(`📭 Email failed: ${err.message}`);
            }
        } else {
            console.log(`🛑 Dry run mode — email not sent`);
        }

        try {
            fs.appendFileSync(alertsPath, `Run on ${new Date().toISOString()}\n${subject}\n${body}\n\n`);
        } catch (err) {
            console.warn(`⚠️ Failed to append alerts: ${err.message}`);
        }

        try {
            const output = loadJSON(outputPath) || [];
            output.push(...sorted);
            saveJSON(outputPath, output);
        } catch (err) {
            console.error(`❌ Failed to update output file: ${err.message}`);
        }

        console.log(`🧠 Run complete: ${results.length} new, ${seen.size - results.length} skipped`);

        if (auditMode && expectedCount && auditPath) {
            fs.appendFileSync(path.join(auditPath, 'summary.txt'), `Total vehicles listed on site: ${expectedCount}\n`);
        }

        const missingIds = Array.from(seenVehicles.keys()).filter(id => !results.find(v => v.id === id));
        try {
            fs.writeFileSync(missingPath, missingIds.map(id => {
                const meta = seenVehicles.get(id);
                return `ID: ${id}, Page: ${meta.page}, Index: ${meta.index}, URL: ${meta.link}`;
            }).join('\n'));
        } catch (err) {
            console.warn(`⚠️ Failed to write missing vehicles: ${err.message}`);
        }

        console.log(`❓ Missing vehicles logged: ${missingIds.length}`);

        const missingByPage = {};
        for (const [id, meta] of seenVehicles.entries()) {
            if (!results.find(v => v.id === id)) {
                if (!missingByPage[meta.page]) missingByPage[meta.page] = [];
                missingByPage[meta.page].push({ id, index: meta.index, url: meta.link });
            }
        }

        if (auditPath) {
            for (const [page, entries] of Object.entries(missingByPage)) {
                fs.appendFileSync(path.join(auditPath, 'missing_by_page.txt'), `Page ${page} — ${entries.length} missing\n`);
                entries.forEach(entry => {
                    fs.appendFileSync(path.join(auditPath, 'missing_by_page.txt'),
                        `  • Index ${entry.index}, ID: ${entry.id}, URL: ${entry.url}\n`);
                });
            }

            if (expectedCount && seenVehicles.size < expectedCount) {
                const missing = expectedCount - seenVehicles.size;
                console.warn(`❌ Expected ${expectedCount} vehicles, but only saw ${seenVehicles.size} — ${missing} missing`);
                fs.appendFileSync(path.join(auditPath, 'missing_summary.txt'),
                    `${new Date().toISOString()} — Expected: ${expectedCount}, Seen: ${seenVehicles.size}, Missing: ${missing}\n`);
            }

            fs.writeFileSync(duplicatesPath, Array.from(seenVehicles.entries())
                .filter(([id]) => !results.find(v => v.id === id))
                .map(([id, meta]) => `ID: ${id}, Page: ${meta.page}, Index: ${meta.index}, URL: ${meta.link}`)
                .join('\n'));

            for (const v of results) {
                fs.appendFileSync(path.join(auditPath, 'spec_matches.txt'),
                    `ID: ${v.id}, Score: ${v.scorePercent}%\n` +
                    v.matchedSpecs.map(m => `• ${m.spec} (${m.weight})`).join('\n') + '\n\n');

                if (v.unmatchedSpecs?.length > 0) {
                    fs.appendFileSync(path.join(auditPath, 'unmatched_specs.txt'),
                        `ID: ${v.id}\nUnmatched:\n${v.unmatchedSpecs.join('\n')}\n\n`);
                }
            }
        } else {
            console.warn(`⚠️ Audit path not set — skipping audit file writes`);
        }
    }
}

async function retryFailedExtractions(context, currentModel, auditPath, browser) {
    const queuePath = path.join('data', 'reprocess_queue.txt');
    if (!fs.existsSync(queuePath)) return;

    if (!auditPath || typeof auditPath !== 'string') {
        throw new Error(`Invalid auditPath: ${auditPath}`);
    }

    if (!fs.existsSync(auditPath)) {
        fs.mkdirSync(auditPath, { recursive: true });
    }

    const retryLines = fs.readFileSync(queuePath, 'utf-8')
        .split('\n')
        .filter(Boolean);

    if (retryLines.length === 0) return;

    console.log(`🔁 Retrying ${retryLines.length} failed extractions...`);

    const outputPath = path.join('data', `output_${currentModel.replace(/\s+/g, '_')}.json`);
    const output = loadJSON(outputPath) || [];

    for (const line of retryLines) {
        const [vehicleId, fullUrl] = line.split(' — ');
        let retryPage;

        try {
            // Create new tab
            try {
                retryPage = await context.newPage();
                console.log(`[audit] New tab created 6`);
                await retryPage.setViewportSize({ width: 1280, height: 800 });
            } catch (err) {
                console.warn(`⚠️ Failed to create new page during retry: ${err.message}`);
                break;
            }

            // Navigate to URL
            if (detailPage && !detailPage.isClosed()) {
                await detailPage.close();
            }
            console.log(`[audit] New tab created 7`);
            detailPage = await context.newPage();
            await detailPage.setViewportSize({ width: 1280, height: 800 });
            await safeGoto(context, retryPage, fullUrl, vehicleId);

            const url1 = await page.url();
            const title1 = await page.title().catch(() => 'title error');
            const domVisible1 = await page.evaluate(() => document.visibilityState === 'visible');
            const viewport1 = await page.viewportSize();
            const isClosed1 = page.isClosed();
            const isDetached1 = page.mainFrame().isDetached();

            await logAuditEntry({
                auditPath,
                vehicleId,
                event: 'pre-retry diagnostics',
                details: {
                    url1,
                    isClosed1,
                    isDetached1,
                    title1,
                    domVisible1,
                    viewport1
                }
            });

            // 🛡️ Guard clause: skip retry if tab is viable
            if (!diagnostics.isClosed && !diagnostics.isDetached) {
                await logAuditEntry({
                    auditPath,
                    vehicleId,
                    event: 'retry skipped',
                    reason: 'tab still viable',
                    status: 'skipped',
                    details: diagnostics
                });
            }

            // 🧠 Resolve all awaited values before constructing the details object
            const url2 = await page.url();
            const title2 = await page.title().catch(() => 'title error');
            const domVisible2 = await page.evaluate(() => document.visibilityState);
            const contextClosed2 = page.context().isClosed?.();
            const isClosed2 = page.isClosed();
            const isDetached2 = page.mainFrame().isDetached();

            await logAuditEntry({
                auditPath,
                vehicleId,
                event: 'Pre-retry diagnostics',
                status: 'info',
                details: {
                    url2,
                    title2,
                    domVisible2,
                    contextClosed2,
                    isClosed2,
                    isDetached2
                }
            });

            // 🧾 Screenshot before retry extraction
            await page.screenshot({ path: path.join(auditPath, `extractor_retry_entry_${vehicleId}.png`) });
            console.log(`[${vehicleId}] Starting retry extraction`);

            // 🕒 Watchdog wrapper to catch extractor stalls
            const vehicleData = await Promise.race([
                extractVehicleDataFromPage(page, vehicleId, auditPath, retryCount, browser),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`[${vehicleId}] Extractor hard timeout after 20000ms`)), 20000)
                )
            ]);
            await captureAuditArtifacts(retryPage, vehicleId, auditPath); // no err on success
            vehicleData.id = vehicleId;

            // Enrich and timestamp
            const enriched = evaluateSpecs(vehicleData);
            enriched.timestamp = new Date().toISOString();
            output.push(enriched);

            // Save raw data if audit mode
            if (auditMode) {
                fs.appendFileSync(path.join(auditPath, 'raw_vehicle_data.txt'),
                    JSON.stringify({ url: fullUrl, data: vehicleData }, null, 2) + '\n\n');
            }

            const delayMs = 3000 + Math.floor(Math.random() * 2000); // 3–5 seconds
            console.log(`⏳ Sleeping for ${delayMs}ms before next vehicle...`);
            await detailPage.waitForTimeout(delayMs);

            console.log(`✅ Retry successful for ${vehicleId}`);
        } catch (err) {
            console.warn(`❌ Retry failed for ${vehicleId}: ${err.message}`);
            fs.appendFileSync(path.join('data', 'permanent_failures.txt'), `${vehicleId} — ${fullUrl}\n`);
            fs.appendFileSync(path.join(auditPath, 'extractor_errors.txt'),
                `URL: ${fullUrl}\nError: ${err.message}\n\n`);
            await captureAuditArtifacts(retryPage, vehicleId, auditPath, err);
        } finally {
            if (retryPage && !retryPage.isClosed?.()) {
                await retryPage.close();
            }
        }
    }

    saveJSON(outputPath, output);
    fs.unlinkSync(queuePath);

    // ✅ Restart logic
    const models = ['X5', '5 Series', 'i4'];
    const modelIndex = parseInt(process.env.MODEL_INDEX || '0', 10);

    if (modelIndex + 1 < models.length) {
        const nextIndex = modelIndex + 1;
        fs.writeFileSync('.env', `MODEL_INDEX=${nextIndex}\nRETRY_COUNT=0`);
        console.log(`🔁 Restarting for model: ${models[nextIndex]}`);
        process.exit(0);
    } else {
        console.log('✅ All models processed');
    }
}

function restartScript() {
    const { spawn } = require('child_process'); // ✅ must be inside the function or accessible globally
    const args = process.argv.slice(1);
    const retryCount = parseInt(process.env.RETRY_COUNT || '0');

    if (!auditPath || typeof auditPath !== 'string') {
        throw new Error(`Invalid auditPath: ${auditPath}`);
    }

    if (retryCount >= 3) {
        console.error('🛑 Max retries reached. Aborting.');
        fs.appendFileSync(path.join(auditPath, 'restart_log.txt'),
            `${new Date().toISOString()} — Aborted after ${retryCount} retries\n`);
        process.exit(1);
    }

    console.log(`🔁 Restarting scraper with args: ${args.join(' ')}`);

    spawn(process.argv[0], args, {
        stdio: 'inherit',
        detached: true,
        env: { ...process.env, RETRY_COUNT: retryCount + 1 }
    }).unref();

    process.exit(1);
}

(async () => {
    const visitedUrls = new Set();
    const { browser, context, page } = await setupBrowser();

    const results = [];
    let exitReason = 'Completed normally';
    let pageNumber = 1;

    try {
        if (auditMode) {
            if (!auditPath || typeof auditPath !== 'string') {
                throw new Error(`Invalid auditPath: ${auditPath}`);
            }

            if (!fs.existsSync(auditPath)) {
                fs.mkdirSync(auditPath, { recursive: true });
                if (verboseMode) console.log(`✅ Created audit directory at: ${auditPath}`);
            } else {
                if (verboseMode) console.log(`📁 Audit directory already exists: ${auditPath}`);
            }
        }

        await navigateAndFilter(page, currentModel, auditPath);

        const expectedCount = await parseExpectedCount(page);
        const expectedPages = expectedCount ? Math.ceil(expectedCount / 23) : null;

        if (verboseMode) {
            console.log(`🔍 Expected vehicle count: ${expectedCount}`);
            console.log(`📄 Estimated pages: ${expectedPages}`);
        }

        const seen = new Set(loadJSON(seenPath)?.map(id => id.split('?')[0].trim()) || []);
        const seenRegistrations = new Set(loadJSON(seenRegPath) || []);
        const seenVehicles = new Map();

        console.log(`📗 Loaded ${seen.size} seen vehicle IDs`);
        console.log(`📘 Loaded ${seenRegistrations.size} seen registrations`);

        const outputPath = path.join('data', `output_${currentModel.replace(/\s+/g, '_')}.json`);
        const crypto = require('crypto');
        const seenHashes = new Set();
        let hasNextPage = true;

        while (hasNextPage) {
            if (expectedPages && pageNumber > expectedPages) {
                console.warn(`⚠️ Page limit exceeded (${pageNumber}/${expectedPages}). Breaking loop.`);
                exitReason = `Page limit exceeded (${pageNumber}/${expectedPages})`;
                break;
            }

            const currentUrl = await page.url();
            if (visitedUrls.has(currentUrl)) {
                console.warn(`⚠️ Duplicate URL detected: ${currentUrl}`);
                exitReason = `Duplicate URL at page ${pageNumber}`;
                break;
            }
            visitedUrls.add(currentUrl);

            const html = await page.content();
            const hash = crypto.createHash('md5').update(html).digest('hex');

            if (seenHashes.has(hash)) {
                console.warn('⚠️ Duplicate page detected. Breaking loop.');
                exitReason = `Duplicate page hash detected at page ${pageNumber}`;
                break;
            }

            seenHashes.add(hash);

            try {
                console.log(`[audit] New tab created — 8`);
                const detailPage = await context.newPage();
                await detailPage.setViewportSize({ width: 1280, height: 800 });

                const vehicleCountEstimate = await page.locator('.uvl-c-vehicle-card').count();
                const timeoutMs = Math.max(30000, 10000 + vehicleCountEstimate * 3000);
                console.log(`timeout ${timeoutMs}ms & ${vehicleCountEstimate} vehicles`);

                await scrapePage(
                    page, detailPage, context, browser,
                    {
                        pageNumber,
                        expectedPages,
                        expectedCount,
                        seen,
                        seenVehicles,
                        results,
                        seenRegistrations,
                        currentModel,
                        auditPath
                    }
                );

            } catch (err) {
                console.error(`❌ Error scraping page ${pageNumber}:`, err);

                if (auditMode) {
                    const failPath = path.resolve(auditPath, `fail_page_${pageNumber}.txt`);
                    fs.writeFileSync(failPath, `Failed at ${new Date().toISOString()}\n${err.stack}`);
                }

                exitReason = `Error during scrapePage at page ${pageNumber}: ${err.message}`;
                break;
            }

            pageNumber++;
        }

        if (auditMode) {
            const loopLogPath = path.resolve(auditPath, 'loop_exit_log.txt');
            fs.appendFileSync(loopLogPath,
                `${new Date().toISOString()} — Exited at page ${pageNumber} — Reason: ${exitReason}\n`);
        }

        let previousLog = [];
        try {
            if (fs.existsSync(outputPath)) {
                previousLog = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
            }
        } catch (err) {
            console.error(`❌ Failed to parse output.json: ${err.message}`);
            previousLog = [];
        }

        const currentIds = results.map(v => v.id);
        const updatedLog = previousLog.map(vehicle => {
            if (currentIds.includes(vehicle.id)) {
                return { ...vehicle, missingCount: 0 };
            } else {
                return {
                    ...vehicle,
                    missingCount: (vehicle.missingCount || 0) + 1
                };
            }
        });

        const finalLog = updatedLog.filter(v => v.missingCount < 2);
        const removed = updatedLog.filter(v => v.missingCount >= 2);

        saveJSON(outputPath, finalLog);

        const scopedRemovedPath = path.resolve(auditPath, `removed_vehicles_${currentModel.replace(/\s+/g, '_')}.json`);
        let archive = [];

        if (fs.existsSync(scopedRemovedPath)) {
            archive = JSON.parse(fs.readFileSync(scopedRemovedPath, 'utf-8'));
        }

        const now = new Date().toISOString();
        archive.push(...removed.map(v => ({ ...v, removedAt: now })));
        saveJSON(scopedRemovedPath, archive);

        if (verboseMode) {
            console.log(`🧮 Updated missingCount for ${updatedLog.length} vehicles`);
            console.log(`🗑️ Removed ${removed.length} vehicles from output.json`);
        }

        await retryFailedExtractions(context, currentModel, auditPath, browser);

        await finaliseRun({
            seen,
            results,
            seenVehicles,
            expectedCount,
            currentModel,
            auditPath,
            auditMode,
            verboseMode
        });

        saveJSON(seenPath, Array.from(seen));
        saveJSON(seenRegPath, Array.from(seenRegistrations));

        console.log(`📕 Saved ${seen.size} seen vehicle IDs`);
        console.log(`📙 Saved ${seenRegistrations.size} seen registrations`);

        if (verboseMode) console.log('✅ Scraper run completed successfully.');
    } catch (err) {
        console.error('❌ Error:', err);

        try {
            if (page && !page.isClosed?.()) {
                await page.screenshot({ path: path.join(auditPath, `error-screenshot.png`) });
            }
        } catch (screenshotErr) {
            console.warn(`⚠️ Failed to capture error screenshot: ${screenshotErr.message}`);
        }

        if (auditMode) {
            const restartLogPath = path.resolve(process.cwd(), path.join(auditPath, 'restart_log.txt'));
            fs.appendFileSync(
                restartLogPath,
                `${new Date().toISOString()} — Restarting due to: ${err.message}\n`
            );
        }

        try {
            fs.appendFileSync(path.join(auditPath, 'run_summary.txt'),
                `Run completed at ${new Date().toISOString()}\n` +
                `Total vehicles processed: ${results?.length || 0}\n` +
                `Pages scraped: ${pageNumber ?? 'unknown'}\n` +
                `Exit reason: ${exitReason ?? 'Unknown error'}\n\n`
            );
        } catch (logErr) {
            console.warn(`⚠️ Failed to write run summary: ${logErr.message}`);
        }

        if (typeof restartScript === 'function') {
            restartScript();
        }
    } finally {
        await browser.close();
    }
})();
