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

const retryCount = parseInt(process.env.RETRY_COUNT || '0');

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

if (retryCount >= 3) {
    console.error('🛑 Max retries reached. Aborting.');
    fs.appendFileSync('audit/restart_log.txt',
        `${new Date().toISOString()} — Aborted after ${retryCount} retries\n`);
    process.exit(1);
}

async function safeGoto(page, url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            if (page.isClosed?.()) throw new Error('Target page is closed');
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            return;
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

    await page.waitForTimeout(1000);
    const variant50e = page.locator('#variant >> .react-select-option:has-text("50e")');
    await variant50e.click();
    console.log('✅ Selected variant: 50e');

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
    results
}) {
    console.log(`📄 Scraping page ${pageNumber}`);

    const containers = await page.locator('.uvl-c-advert').elementHandles();
    const hrefs = [];

    for (let i = 0; i < containers.length; i++) {
        const container = containers[i];
        const linkHandles = await container.$$('a[href*="/vehicle/"]');
        let added = false;

        for (const linkHandle of linkHandles) {
            const href = await linkHandle.getAttribute('href');
            const idMatch = href?.match(/vehicle\/([^?]+)/);
            const id = idMatch ? idMatch[1].trim() : null;

            if (id) {
                hrefs.push(href);
                added = true;
                break;
            }
        }

        if (!added && auditMode) {
            const html = await container.evaluate(el => el.outerHTML);
            fs.appendFileSync('audit/missing_anchors.txt', `Page ${pageNumber}, Container ${i}:\n${html}\n\n`);
        }

        fs.appendFileSync(rawDetailsPath, `Page ${pageNumber} — ${vehicle.title}\n`);
        fs.appendFileSync(rawDetailsPath, JSON.stringify(vehicle, null, 2) + '\n\n');
    }

    if (auditMode) {
        const containerHTML = await page.locator('.uvl-c-advert').evaluateAll(elements =>
            elements.map(el => el.outerHTML)
        );
        fs.writeFileSync(`audit/page_${pageNumber}_containers.html`, containerHTML.join('\n\n'));
    }

    const uniqueHrefs = Array.from(new Set(hrefs.map(h => h.trim())));
    console.log(`✅ Unique vehicle links: ${uniqueHrefs.length}`);

    if (auditMode) {
        fs.writeFileSync(`audit/page_${pageNumber}_raw_blocks.html`, hrefs.join('\n\n'));
        await page.screenshot({ path: `audit/page-${pageNumber}-pre.png` });
        fs.appendFileSync('audit/page_counts.txt',
            `Page ${pageNumber}: ${hrefs.length} raw links, ${uniqueHrefs.length} unique listings\n`
        );
    }

    const expectedOnPage = (pageNumber < expectedPages) ? 23 : (expectedCount % 23 || 23);
    if (uniqueHrefs.length < expectedOnPage) {
        console.warn(`⚠️ Page ${pageNumber} has only ${uniqueHrefs.length} listings — expected ${expectedOnPage}`);
        fs.appendFileSync('audit/short_pages.txt', `Page ${pageNumber}: ${uniqueHrefs.length} listings (expected ${expectedOnPage})\n`);
    }

    for (let i = 0; i < uniqueHrefs.length; i++) {
        const href = uniqueHrefs[i];
        const fullUrl = new URL(href, 'https://usedcars.bmw.co.uk').toString();
        const vehicleIdMatch = fullUrl.match(/vehicle\/([^?]+)/);
        const vehicleId = vehicleIdMatch ? vehicleIdMatch[1].trim() : `unknown-${Date.now()}`;

        if (seen.has(vehicleId)) {
            if (auditMode) {
                fs.appendFileSync('audit/skipped_links.txt', `Page ${pageNumber}, Index ${i}: ${vehicleId}\n`);
            }
            continue;
        }

        seenVehicles.set(vehicleId, { page: pageNumber, index: i, link: fullUrl });
        console.log(`🔍 Extracting data from: ${fullUrl}`);

        let start = Date.now();
        if (!detailPage || detailPage.isClosed?.()) {
            detailPage = await context.newPage();
        }
        await safeGoto(detailPage, fullUrl);
        const loadTime = Date.now() - start;
        console.log(`⏱️ Page load took ${loadTime}ms`);

        let vehicleData;
        try {
            vehicleData = await Promise.race([
                extractVehicleDataFromPage(detailPage),
                new Promise((_, reject) => setTimeout(() => reject(new Error('⏱️ Extraction timeout')), 10000))
            ]);
        } catch (err) {
            console.warn(`⚠️ Extraction failed for ${fullUrl}: ${err.message}`);
            fs.appendFileSync('data/reprocess_queue.txt', `${vehicleId} — ${fullUrl}\n`);
            fs.appendFileSync('audit/extractor_errors.txt',
                `URL: ${fullUrl}\nError: ${err.message}\n\n`);
            continue;
        }

        vehicleData.id = vehicleId;
        if (auditMode) {
            fs.appendFileSync('audit/raw_vehicle_data.txt',
                JSON.stringify({ url: fullUrl, data: vehicleData }, null, 2) + '\n\n');
        }
        const enriched = evaluateSpecs(vehicleData);
        enriched.timestamp = new Date().toISOString();
        results.push(enriched);
        seen.add(vehicleId);

        // ✅ Log raw details per vehicle
        if (auditMode && rawDetailsPath) {
            fs.appendFileSync(rawDetailsPath, `Page ${pageNumber} — ${vehicleData.title || 'Untitled'}\n`);
            fs.appendFileSync(rawDetailsPath, JSON.stringify(vehicleData, null, 2) + '\n\n');
        }


        await new Promise(res => setTimeout(res, 1500));
        if (results.length % 25 === 0) {
            await detailPage.close();
            detailPage = await context.newPage();
            console.log(`🔄 Detail page reset after ${results.length} vehicles`);
        }
    }

    if (auditMode) {
        await page.screenshot({ path: `audit/page-${pageNumber}.png` });
        console.log(`📸 Audit screenshot saved: page-${pageNumber}.png`);
    }

    const nextButton = page.locator('li.page-next a.page-link[aria-label="Next page"]');
    let hasNextPage = await nextButton.isVisible();
    console.log(`🔍 Next button visible: ${hasNextPage}`);

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
    console.log(`🧾 Seen vehicle IDs:\n${Array.from(seen).join('\n')}`);

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
    const { spawn } = require('child_process');
    const args = process.argv.slice(1); // preserve flags like --audit, --headless

    console.log(`🔁 Restarting scraper with args: ${args.join(' ')}`);
    spawn(process.argv[0], args, {
        stdio: 'inherit',
        detached: true
    }).unref();

    process.exit(1); // exit current run
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
                    auditMode,
                    verboseMode
                });

                const score = calculateScore(pageData.extracted, pageData.expected);

                if (score < 30 || pageData.extracted.model !== pageData.expected.model) {
                    console.warn(`❌ Model mismatch or low score (${score}%). Aborting run.`);
                    fs.appendFileSync(rawDetailsPath, `❌ Aborted due to mismatch at page ${pageNumber}\n`);
                    process.exit(1);
                }

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

        // Audit log for loop exit
        if (auditMode) {
            const loopLogPath = path.resolve(auditPath, 'loop_exit_log.txt');
            fs.appendFileSync(loopLogPath,
                `${new Date().toISOString()} — Exited at page ${pageNumber} — Reason: ${exitReason}\n`);
        }

        await finaliseRun({ seen, results, seenVehicles, expectedCount, auditMode, verboseMode });
        await retryFailedExtractions(context, auditMode, verboseMode);

        if (verboseMode) console.log('✅ Scraper run completed successfully.');
    } catch (err) {
        console.error('❌ Error:', err);

        await page.screenshot({ path: 'error-screenshot.png' });

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