// chunk-1.js
const { chromium } = require('playwright');
const { evaluateSpecs } = require('./utils/specEvaluator');
require('dotenv').config();
const { sendEmail } = require('./utils/emailSender');
const { extractVehicleDataFromPage } = require('./utils/vehicleExtractor');
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

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const rawDetailsPath = path.resolve('audit', `raw_details_${timestamp}.txt`);

const argv = yargs(hideBin(process.argv)).argv;

const auditPath = path.resolve(process.cwd(), 'audit');

if (auditMode && !fs.existsSync(auditPath)) {
    fs.mkdirSync(auditPath, { recursive: true });
}

const retryCount = parseInt(process.env.RETRY_COUNT || '0');
if (retryCount >= 3) {
    console.error('🛑 Max retries reached. Aborting.');
    fs.appendFileSync('audit/restart_log.txt',
        `${new Date().toISOString()} — Aborted after ${retryCount} retries\n`);
    process.exit(1);
}

async function safeGoto(page, url, vehicleId = 'unknown', retries = 3) {

    console.log('✅ safeGoto module loaded');

    for (let i = 0; i < retries; i++) {
        try {
            if (page.isClosed?.()) throw new Error('Target page is closed');

            const response = await Promise.race([
                page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('⏱️ goto timeout')), 20000))
            ]);

            if (!response || !response.ok()) {
                console.warn(`⚠️ Navigation failed: ${response?.status()} — ${url}`);
                fs.appendFileSync('audit/bad_responses.txt', `Vehicle ID: ${vehicleId}, Status: ${response?.status()} — ${url}\n`);
                continue;
            }

            await page.waitForTimeout(2000); // allow rendering

            const content = await page.content();
            if (!content || content.length < 1000) {
                console.warn(`⚠️ Page content too short — possible blank page: ${url}`);
                fs.writeFileSync(`audit/blank_vehicle_${vehicleId}.html`, content);
                await page.screenshot({ path: `audit/blank_vehicle_${vehicleId}.png` });
                continue; // retry
            }

            return; // success
        } catch (err) {
            console.warn(`⚠️ Retry ${i + 1} failed for ${url}: ${err.message}`);
            await new Promise(res => setTimeout(res, 1500));
        }
    }

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

async function navigateAndFilter(page) {
    console.log('Navigating to BMW Approved Used site...');
    await page.goto('https://usedcars.bmw.co.uk/');
    await page.click('button:has-text("Reject")');
    console.log('✅ Cookies rejected');

    await page.click('#series');
    await page.waitForTimeout(1000);
    for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    console.log('✅ Selected X Series');

    await page.click('#body_style');
    await page.waitForTimeout(1000);
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    await page.click('button.uvl-c-expected-results-btn');
    console.log('✅ Search button clicked');

    await page.click('button[data-tracking-effect="Additional filters"]');
    await page.locator('a.rc-collapse-header:has-text("Model variant")').click();
    await page.locator('span.uvl-c-select__placeholder', { hasText: 'Engine derivatives' }).click();
    await page.evaluate(() => {
        const menu = document.querySelector('#react-select-7-listbox');
        if (menu) menu.scrollTop = menu.scrollHeight;
    });

    await page.waitForTimeout(2000);
    const variantOption = page.locator('#variant .react-select-option:has-text("50e")');

    try {
        await variantOption.waitFor({ state: 'visible', timeout: 10000 });
        await variantOption.click();
        console.log('✅ Variant "50e" selected');
    } catch (err) {
        console.warn('⚠️ First attempt failed — retrying...');
        await page.waitForTimeout(2000);

        try {
            await variantOption.click();
            console.log('✅ Variant "50e" selected on retry');
        } catch (finalErr) {
            const msg = `Variant "50e" failed twice — aborting model`;
            console.warn(`❌ ${msg}`);
            fs.appendFileSync('audit/variant_failure.txt',
                `${new Date().toISOString()} — ${msg}\n`);
            throw new Error(msg); // ✅ force model-level failure
        }
    }

    await page.waitForTimeout(1500);
    await page.click('button.uvl-c-expected-results-btn');
    console.log('✅ Final search triggered with engine derivative');

    await page.waitForTimeout(3000);
    await page.waitForSelector('a.uvl-c-advert__media-link[href*="/vehicle/"]');
    console.log('✅ Listings loaded');
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

async function scrapePage(page, detailPage, context, {
    pageNumber,
    expectedPages,
    expectedCount,
    seen,
    seenVehicles,
    results,
    seenRegistrations
}) {
    console.log(`📄 Scraping page ${pageNumber}`);

    const containers = await page.locator('.uvl-c-advert').elementHandles();
    const vehiclesToProcess = [];

    for (let i = 0; i < containers.length; i++) {
        const container = containers[i];

        const regHandle = await container.$('span[itemprop="vehicleRegistration"]');
        const regText = regHandle ? await regHandle.innerText() : null;
        const registration = regText?.trim();

        const linkHandle = await container.$('a[href*="/vehicle/"]');
        const href = linkHandle ? await linkHandle.getAttribute('href') : null;

        if (!registration || !href) {
            if (auditMode) {
                const html = await container.evaluate(el => el.outerHTML);
                fs.appendFileSync('audit/missing_data.txt', `Page ${pageNumber}, Container ${i}:\n${html}\n\n`);
            }
            continue;
        }

        if (seenRegistrations.has(registration)) {
            console.log(`⏭️ Skipping already-seen registration: ${registration}`);
            if (auditMode) {
                fs.appendFileSync('audit/skipped_registrations.txt', `Page ${pageNumber}, Index ${i}: ${registration}\n`);
            }
            continue;
        }

        vehiclesToProcess.push({ registration, href });
    }

    if (auditMode) {
        const containerHTML = await page.locator('.uvl-c-advert').evaluateAll(elements =>
            elements.map(el => el.outerHTML)
        );
        fs.writeFileSync(`audit/page_${pageNumber}_containers.html`, containerHTML.join('\n\n'));
    }

    console.log(`✅ Vehicles to process: ${vehiclesToProcess.length}`);

    const expectedOnPage = (pageNumber < expectedPages) ? 23 : (expectedCount % 23 || 23);
    if (vehiclesToProcess.length < expectedOnPage) {
        console.warn(`⚠️ Page ${pageNumber} has only ${vehiclesToProcess.length} listings — expected ${expectedOnPage}`);
        fs.appendFileSync('audit/short_pages.txt', `Page ${pageNumber}: ${vehiclesToProcess.length} listings (expected ${expectedOnPage})\n`);
    }

    for (let i = 0; i < vehiclesToProcess.length; i++) {
        const { registration, href } = vehiclesToProcess[i];
        const fullUrl = new URL(href, 'https://usedcars.bmw.co.uk').toString();
        const vehicleIdMatch = fullUrl.match(/vehicle\/([^?]+)/);
        const vehicleId = vehicleIdMatch ? vehicleIdMatch[1].trim() : `unknown-${Date.now()}`;

        const gracePass = pageNumber === 1 && i < 3;

        seenVehicles.set(vehicleId, { page: pageNumber, index: i, link: fullUrl });
        console.log(`🔍 Extracting data from: ${fullUrl}`);

        let start = Date.now();
        if (!detailPage || detailPage.isClosed?.()) {
            detailPage = await context.newPage();
            await detailPage.setViewportSize({ width: 1280, height: 800 });
        }

        try {
            await safeGoto(detailPage, fullUrl, vehicleId);
            const loadTime = Date.now() - start;
            console.log(`⏱️ Page load took ${loadTime}ms`);
        } catch (err) {
            console.error(`❌ safeGoto threw an error for ${fullUrl}:`, err.message);
            fs.appendFileSync('audit/safeGoto_errors.txt', `Vehicle ID: ${vehicleId}, Error: ${err.message} — ${fullUrl}\n`);
            continue;
        }

        if (i === 0 && auditMode) {
            const html = await detailPage.content();
            fs.writeFileSync(`audit/first_vehicle_debug.html`, html);
        }

        let vehicleData;
        try {
            vehicleData = await Promise.race([
                extractVehicleDataFromPage(detailPage),
                new Promise((_, reject) => setTimeout(() => reject(new Error('⏱️ Extraction timeout')), 10000))
            ]);

            if (!vehicleData || Object.keys(vehicleData).length === 0) {
                console.warn(`⚠️ Empty vehicle data — retrying with fresh tab`);
                detailPage = await context.newPage();
                await detailPage.setViewportSize({ width: 1280, height: 800 });
                await safeGoto(detailPage, fullUrl);
                vehicleData = await extractVehicleDataFromPage(detailPage);
            }

        } catch (err) {
            console.warn(`⚠️ Extraction failed for ${fullUrl}: ${err.message}`);
            fs.appendFileSync('data/reprocess_queue.txt', `${vehicleId} — ${fullUrl}\n`);
            fs.appendFileSync('audit/extractor_errors.txt',
                `URL: ${fullUrl}\nError: ${err.message}\n\n`);
            continue;
        }

        vehicleData.id = vehicleId;
        vehicleData.registration = registration;
        seen.add(vehicleId);
        seenRegistrations.add(registration);

        if (auditMode) {
            fs.appendFileSync('audit/raw_vehicle_data.txt',
                JSON.stringify({ url: fullUrl, data: vehicleData }, null, 2) + '\n\n');
        }

        const enriched = evaluateSpecs(vehicleData);
        enriched.timestamp = new Date().toISOString();
        results.push(enriched);

        if (auditMode && rawDetailsPath) {
            fs.appendFileSync(rawDetailsPath, `Page ${pageNumber} — ${vehicleData.title || 'Untitled'}\n`);
            fs.appendFileSync(rawDetailsPath, JSON.stringify(vehicleData, null, 2) + '\n\n');
        }

        await new Promise(res => setTimeout(res, 1500));
        if (results.length % 25 === 0) {
            await detailPage.close();
            detailPage = await context.newPage();
            await detailPage.setViewportSize({ width: 1280, height: 800 });
            console.log(`🔄 Detail page reset after ${results.length} vehicles`);
        }
    }

    if (auditMode) {
        await page.screenshot({ path: `audit/page-${pageNumber}.png` });
        console.log(`📸 Audit screenshot saved: page-${pageNumber}.png`);
    }

    const html = await page.content();
    fs.writeFileSync(`audit/page_${pageNumber}_dom.html`, html);

    const nextButton = page.locator('a.uvl-c-pagination__direction--next[aria-label="Next page"]');
    let hasNextPage = await nextButton.isVisible();
    console.log(`🔍 Next button found: ${await nextButton.count()}`);
    console.log(`🔍 Next button visible: ${await nextButton.isVisible()}`);
    console.log(`🔍 Current page URL: ${await page.url()}`);

    if (hasNextPage) {
        const currentUrl = page.url();
        try {
            await nextButton.click({ force: true });
            await page.waitForTimeout(1500);
        } catch (err) {
            console.warn(`⚠️ Failed to click next: ${err.message}`);
            hasNextPage = false;
        }

        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);

        const newUrl = page.url();
        if (newUrl === currentUrl) {
            console.warn('⚠️ Pagination click did not advance — retrying once...');
            try {
                await page.waitForTimeout(2000);
                await nextButton.click({ force: true });
                await page.waitForLoadState('networkidle');
                await page.waitForTimeout(2000);
            } catch (err) {
                console.warn(`❌ Retry click failed: ${err.message}`);
            }

            if (page.url() === currentUrl) {
                console.warn('❌ Still stuck — breaking loop');
                hasNextPage = false;
            }
        }
    }

    if (!hasNextPage || (expectedPages && pageNumber >= expectedPages)) {
        console.log(`🛑 Final page reached — no further pagination attempted`);
        hasNextPage = false;
    }

    return { hasNextPage };
}

async function finaliseRun({ seen, results, seenVehicles, expectedCount }) {
    saveJSON('seen_vehicles.json', Array.from(seen).map(id => id.split('?')[0].trim()));

    fs.writeFileSync('data/skipped_ids.txt', Array.from(seen)
        .filter(id => !results.find(v => v.id === id))
        .join('\n'));

    console.log(`✅ Total vehicles assessed this run: ${results.length}`);
    console.log(`📦 Total vehicles ever seen: ${seen.size}`);
    console.log(`⏩ Skipped as already seen: ${seen.size - results.length}`);
    console.log(`🕒 Run completed at: ${new Date().toLocaleString()}`);
    //console.log(`🧾 Seen vehicle IDs:\n${Array.from(seen).join('\n')}`);

    if (results.length > 0) {
        const sorted = results.sort((a, b) => b.scorePercent - a.scorePercent);
        const lines = sorted.map(v => `• ${v.title} — ${v.scorePercent}% match\n${v.url}`).join('\n\n');
        const subject = `🚗 BMW Digest: ${sorted.length} vehicles assessed`;
        const body = `Here are the top matches:\n\n${lines}`;

        if (!dryRun) {
            if (verboseMode) console.log('📤 Attempting to send email...');
            await sendEmail({ subject, body });
            console.log(`📧 Sent digest with ${sorted.length} vehicles`);
        } else {
            console.log(`🛑 Dry run mode — email not sent`);
        }

        fs.appendFileSync('data/alerts.txt', `Run on ${new Date().toISOString()}\n${subject}\n${body}\n\n`);

        const output = loadJSON('output.json') || [];
        output.push(...sorted);
        saveJSON('output.json', output);

        console.log(`🧠 Run complete: ${results.length} new, ${seen.size - results.length} skipped`);

        if (auditMode && expectedCount) {
            fs.appendFileSync('audit/summary.txt', `Total vehicles listed on site: ${expectedCount}\n`);
        }

        const missingIds = Array.from(seenVehicles.keys()).filter(id => !results.find(v => v.id === id));
        fs.writeFileSync('data/missing_vehicles.txt', missingIds.map(id => {
            const meta = seenVehicles.get(id);
            return `ID: ${id}, Page: ${meta.page}, Index: ${meta.index}, URL: ${meta.link}`;
        }).join('\n'));

        console.log(`❓ Missing vehicles logged: ${missingIds.length}`);

        const missingByPage = {};
        for (const [id, meta] of seenVehicles.entries()) {
            if (!results.find(v => v.id === id)) {
                if (!missingByPage[meta.page]) missingByPage[meta.page] = [];
                missingByPage[meta.page].push({ id, index: meta.index, url: meta.link });
            }
        }

        for (const [page, entries] of Object.entries(missingByPage)) {
            fs.appendFileSync('audit/missing_by_page.txt', `Page ${page} — ${entries.length} missing\n`);
            entries.forEach(entry => {
                fs.appendFileSync('audit/missing_by_page.txt',
                    `  • Index ${entry.index}, ID: ${entry.id}, URL: ${entry.url}\n`);
            });
        }

        if (expectedCount && seenVehicles.size < expectedCount) {
            const missing = expectedCount - seenVehicles.size;
            console.warn(`❌ Expected ${expectedCount} vehicles, but only saw ${seenVehicles.size} — ${missing} missing`);
            fs.appendFileSync('audit/missing_summary.txt',
                `${new Date().toISOString()} — Expected: ${expectedCount}, Seen: ${seenVehicles.size}, Missing: ${missing}\n`);
        }

        fs.writeFileSync('data/duplicates.txt', Array.from(seenVehicles.entries())
            .filter(([id]) => !results.find(v => v.id === id))
            .map(([id, meta]) => `ID: ${id}, Page: ${meta.page}, Index: ${meta.index}, URL: ${meta.link}`)
            .join('\n'));

        if (auditMode) {
            for (const v of results) {
                fs.appendFileSync('audit/spec_matches.txt',
                    `ID: ${v.id}, Score: ${v.scorePercent}%\n` +
                    v.matchedSpecs.map(m => `• ${m.spec} (${m.weight})`).join('\n') + '\n\n');

                if (v.unmatchedSpecs?.length > 0) {
                    fs.appendFileSync('audit/unmatched_specs.txt',
                        `ID: ${v.id}\nUnmatched:\n${v.unmatchedSpecs.join('\n')}\n\n`);
                }
            }
        }
    }
}

async function retryFailedExtractions(context) {
    if (!fs.existsSync('data/reprocess_queue.txt')) return;

    const retryLines = fs.readFileSync('data/reprocess_queue.txt', 'utf-8')
        .split('\n')
        .filter(Boolean);

    if (retryLines.length === 0) return;

    console.log(`🔁 Retrying ${retryLines.length} failed extractions...`);
    const retryPage = await context.newPage();

    for (const line of retryLines) {
        const [vehicleId, fullUrl] = line.split(' — ');
        try {
            await safeGoto(retryPage, fullUrl);
            const vehicleData = await extractVehicleDataFromPage(retryPage);

            if (auditMode) {
                fs.appendFileSync('audit/raw_vehicle_data.txt',
                    JSON.stringify({ url: fullUrl, data: vehicleData }, null, 2) + '\n\n');
            }

            vehicleData.id = vehicleId;
            const enriched = evaluateSpecs(vehicleData);
            enriched.timestamp = new Date().toISOString();

            const output = loadJSON('output.json') || [];
            output.push(enriched);
            saveJSON('output.json', output);

            console.log(`✅ Retry successful for ${vehicleId}`);
        } catch (err) {
            console.warn(`❌ Retry failed for ${vehicleId}: ${err.message}`);
            fs.appendFileSync('data/permanent_failures.txt', `${vehicleId} — ${fullUrl}\n`);
            fs.appendFileSync('audit/extractor_errors.txt',
                `URL: ${fullUrl}\nError: ${err.message}\n\n`);
        }
    }

    await retryPage.close();
    fs.unlinkSync('data/reprocess_queue.txt');
}

function restartScript() {
    const { spawn } = require('child_process'); // ✅ must be inside the function or accessible globally
    const args = process.argv.slice(1);
    const retryCount = parseInt(process.env.RETRY_COUNT || '0');

    if (retryCount >= 3) {
        console.error('🛑 Max retries reached. Aborting.');
        fs.appendFileSync('audit/restart_log.txt',
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
    const { browser, context, page } = await setupBrowser();

    try {
        if (auditMode) {
            const auditPath = path.resolve(process.cwd(), 'audit');
            if (!fs.existsSync(auditPath)) {
                fs.mkdirSync(auditPath, { recursive: true });
                if (verboseMode) console.log(`✅ Created audit directory at: ${auditPath}`);
            } else {
                if (verboseMode) console.log(`📁 Audit directory already exists: ${auditPath}`);
            }
        }

        await navigateAndFilter(page);

        const expectedCount = await parseExpectedCount(page);
        const expectedPages = expectedCount ? Math.ceil(expectedCount / 23) : null;

        if (verboseMode) {
            console.log(`🔍 Expected vehicle count: ${expectedCount}`);
            console.log(`📄 Estimated pages: ${expectedPages}`);
        }

        const seen = new Set(loadJSON('seen_vehicles.json')?.map(id => id.split('?')[0].trim()) || []);
        const seenRegistrations = new Set(loadJSON('seen_registrations.json') || []);
        console.log(`📘 Loaded ${seenRegistrations.size} seen registrations`);
        const results = [];
        const seenVehicles = new Map();
        const detailPage = await context.newPage();

        const crypto = require('crypto');
        const seenHashes = new Set();
        let pageNumber = 1;
        let hasNextPage = true;
        let exitReason = 'Completed normally';

        while (hasNextPage) {
            // Defensive: Cap page count
            if (expectedPages && pageNumber > expectedPages) {
                console.warn(`⚠️ Page limit exceeded (${pageNumber}/${expectedPages}). Breaking loop.`);
                exitReason = `Page limit exceeded (${pageNumber}/${expectedPages})`;
                break;
            }

            // Defensive: Detect duplicate page loads
            const html = await page.content();
            const hash = crypto.createHash('md5').update(html).digest('hex');

            if (seenHashes.has(hash)) {
                console.warn('⚠️ Duplicate page detected. Breaking loop.');
                exitReason = `Duplicate page hash detected at page ${pageNumber}`;
                break;
            }

            seenHashes.add(hash);

            // Scrape current page
            let pageData;
            try {
                pageData = await scrapePage(page, detailPage, context, {
                    pageNumber,
                    expectedPages,
                    expectedCount,
                    seen,
                    seenVehicles,
                    results,
                    seenRegistrations
                });

/* NOT SURE WHERE THIS CAME FROM
                const score = calculateScore(pageData.extracted, pageData.expected);

                if (score < 30 || pageData.extracted.model !== pageData.expected.model) {
                    console.warn(`❌ Model mismatch or low score (${score}%). Aborting run.`);
                    fs.appendFileSync(rawDetailsPath, `❌ Aborted due to mismatch at page ${pageNumber}\n`);
                    process.exit(1);
                }
*/

                // Defensive: Validate pageData structure
                if (!pageData || typeof pageData.hasNextPage !== 'boolean') {
                    console.warn('⚠️ Invalid pageData returned. Breaking loop.');
                    exitReason = `Invalid pageData structure at page ${pageNumber}`;
                    break;
                }

                hasNextPage = pageData.hasNextPage;
                pageNumber++;
            } catch (err) {
                console.error(`❌ Error scraping page ${pageNumber}:`, err);
                exitReason = `Error during scrapePage at page ${pageNumber}: ${err.message}`;
                break;
            }
        }

        saveJSON('seen_registrations.json', Array.from(seenRegistrations));
        console.log(`📕 Saved ${seenRegistrations.size} seen registrations`);

        // Audit log for loop exit
        if (auditMode) {
            const loopLogPath = path.resolve(auditPath, 'loop_exit_log.txt');
            fs.appendFileSync(loopLogPath,
                `${new Date().toISOString()} — Exited at page ${pageNumber} — Reason: ${exitReason}\n`);
        }

        // Reconcile output.json with current results
        const outputPath = path.resolve('audit', 'output.json');
        let previousLog = [];

        if (fs.existsSync(outputPath)) {
            previousLog = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
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
        fs.writeFileSync(outputPath, JSON.stringify(finalLog, null, 2));

        // Archive removed vehicles
        const removed = updatedLog.filter(v => v.missingCount >= 2);
        const removedPath = path.resolve('audit', 'removed_vehicles.json');
        let archive = [];

        if (fs.existsSync(removedPath)) {
            archive = JSON.parse(fs.readFileSync(removedPath, 'utf-8'));
        }

        const now = new Date().toISOString();
        archive.push(...removed.map(v => ({ ...v, removedAt: now })));
        fs.writeFileSync(removedPath, JSON.stringify(archive, null, 2));

        if (verboseMode) {
            console.log(`🧮 Updated missingCount for ${updatedLog.length} vehicles`);
            console.log(`🗑️ Removed ${removed.length} vehicles from output.json`);
        }

        await finaliseRun({ seen, results, seenVehicles, expectedCount, auditMode, verboseMode });
        await retryFailedExtractions(context, auditMode, verboseMode);

        if (verboseMode) console.log('✅ Scraper run completed successfully.');
    } catch (err) {
        console.error('❌ Error:', err);

        try {
            if (page && !page.isClosed?.()) {
                await page.screenshot({ path: 'error-screenshot.png' });
            }
        } catch (screenshotErr) {
            console.warn(`⚠️ Failed to capture error screenshot: ${screenshotErr.message}`);
        }

        if (auditMode) {
            const restartLogPath = path.resolve(process.cwd(), 'audit/restart_log.txt');
            fs.appendFileSync(
                restartLogPath,
                `${new Date().toISOString()} — Restarting due to: ${err.message}\n`
            );
        }

        if (typeof restartScript === 'function') {
            restartScript();
        }
    } finally {
        await browser.close();
    }
})();