// chunk-1.js
require('dotenv').config();
const { chromium } = require('playwright');
const { evaluateSpecs } = require('./utils/specEvaluator');
const { sendEmail } = require('./utils/emailSender');
const { extractVehiclesFromPage, extractVehicleDataFromPage } = require('./utils/vehicleExtractor');
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


const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const rawDetailsPath = path.resolve('audit', `raw_details_${timestamp}.txt`);

const argv = yargs(hideBin(process.argv)).argv;

const models = ['X5', '5 Series'];
const modelIndex = parseInt(process.env.MODEL_INDEX || '0', 10);
const currentModel = models[modelIndex];
const auditPath = path.resolve(process.cwd(), 'audit', currentModel);

const selectorMap = require('./utils/selectors');
const selectors = selectorMap[currentModel] || selectorMap['X5'];
if (!selectors) {
    throw new Error(`❌ No selectors defined for model: ${currentModel}`);
}

const seenPath = path.join('data', `seen_vehicles_${currentModel.replace(/\s+/g, '_')}.json`);
const seenRegPath = path.join('data', `seen_registrations_${currentModel.replace(/\s+/g, '_')}.json`);


console.log(`🔍 MODEL_INDEX=${process.env.MODEL_INDEX}, currentModel=${currentModel}`);

if (auditMode && !fs.existsSync(auditPath)) {
    fs.mkdirSync(auditPath, { recursive: true });
}

const retryCount = parseInt(process.env.RETRY_COUNT || '0');
if (retryCount >= 3) {
    console.error('🛑 Max retries reached. Aborting.');
    fs.appendFileSync(path.join(auditPath, 'restart_log.txt'),
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
                fs.appendFileSync(path.join(auditPath, 'bad_responses.txt'), `Vehicle ID: ${vehicleId}, Status: ${response?.status()} — ${url}\n`);
                continue;
            }

            await page.waitForTimeout(2000); // allow rendering

            const content = await page.content();
            if (!content || content.length < 1000) {
                console.warn(`⚠️ Page content too short — possible blank page: ${url}`);
                fs.writeFileSync(path.join(auditPath, 'blank_vehicle_${vehicleId}.html'), content);
                await page.screenshot({ path: path.join(auditPath, `blank_vehicle_${vehicleId}.html`) });
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

async function navigateAndFilter(page, currentModel, auditPath) {
  console.log(`🌐 Navigating to BMW Approved Used site for ${currentModel}...`);
  const modelConfig = getModelSelectorConfig(currentModel);
  if (!modelConfig) throw new Error(`❌ No selector config found for model: ${currentModel}`);

  await page.goto('https://usedcars.bmw.co.uk/');
  await page.click('button:has-text("Reject")');
  console.log('✅ Cookies rejected');
  await page.waitForTimeout(1000);

  await page.screenshot({ path: path.join(auditPath, 'failure_before_series.png') });

  // Select Series
  await page.waitForSelector('#series', { timeout: 60000 });
  await page.click('#series');
  await page.waitForTimeout(1000);
  for (let i = 0; i < modelConfig.seriesIndex; i++) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  console.log(`✅ Selected series for ${currentModel}`);

  // Select Body Style (if applicable)
  if (!modelConfig.skipBodyStyle) {
    await page.waitForSelector('#body_style', { timeout: 60000 });
    await page.click('#body_style');
    await page.waitForTimeout(1000);
    for (let i = 0; i < modelConfig.bodyStyleIndex; i++) await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(500);
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

  // Open engine derivatives dropdown
  const engineDropdown = page.locator('span.uvl-c-select__placeholder', {
    hasText: 'Engine derivatives'
  });
  await engineDropdown.waitFor({ state: 'visible', timeout: 10000 });
  await engineDropdown.click();
  console.log('✅ Engine derivatives dropdown clicked');

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
      fs.appendFileSync(path.join(auditPath, 'variant_failure.txt'),
        `${new Date().toISOString()} — ${msg}\n`);
      throw new Error(msg);
    }
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

async function scrapePage(page, detailPage, context, {
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
    console.log(`📄 Scraping page ${pageNumber}`);

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
            fs.appendFileSync(  path.join(auditPath, 'safeGoto_errors.txt'),  `Vehicle ID: ${vehicleId}, Error: ${err.message} — ${fullUrl}\n`);
            continue;
        }

        if (i === 0 && auditMode) {
            const html = await detailPage.content();
            fs.writeFileSync(path.join(auditPath, `first_vehicle_debug.html`), html);
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
            fs.appendFileSync(path.join(auditPath, 'extractor_errors.txt'),
                `URL: ${fullUrl}\nError: ${err.message}\n\n`);
            continue;
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
            detailPage = await context.newPage();
            await detailPage.setViewportSize({ width: 1280, height: 800 });
            console.log(`🔄 Detail page reset after ${results.length} vehicles`);
        }
    }

    if (auditMode) {
        await page.screenshot({ path: path.join(auditPath, `page-${pageNumber}.png`) });
        console.log(`📸 Audit screenshot saved: page-${pageNumber}.png`);
    }

    const html = await page.content();
    fs.writeFileSync(path.join(auditPath, `page_${pageNumber}_dom.html`), html);

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
    fs.writeFileSync(path.join(auditPath, `page_${pageNumber}_pagination.json`), JSON.stringify(paginationAudit, null, 2));

    let hasNextPage = nextVisible && ariaDisabled === 'false';

    if (hasNextPage) {
        hasNextPage = await attemptPaginationAdvance(page, nextButton, auditPath, pageNumber);
    }

    if (!hasNextPage || (expectedPages && pageNumber >= expectedPages)) {
        console.log(`🛑 Final page reached — no further pagination attempted`);
        hasNextPage = false;
    }

    return { hasNextPage };
}

async function finaliseRun({ seen, results, seenVehicles, expectedCount, currentModel, auditPath }) {
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
            fs.appendFileSync(path.join(auditPath, 'summary.txt'), `Total vehicles listed on site: ${expectedCount}\n`);
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

        fs.writeFileSync('data/duplicates.txt', Array.from(seenVehicles.entries())
            .filter(([id]) => !results.find(v => v.id === id))
            .map(([id, meta]) => `ID: ${id}, Page: ${meta.page}, Index: ${meta.index}, URL: ${meta.link}`)
            .join('\n'));

        if (auditMode) {
            for (const v of results) {
                fs.appendFileSync(path.join(auditPath, 'spec_matches.txt'),
                    `ID: ${v.id}, Score: ${v.scorePercent}%\n` +
                    v.matchedSpecs.map(m => `• ${m.spec} (${m.weight})`).join('\n') + '\n\n');

                if (v.unmatchedSpecs?.length > 0) {
                    fs.appendFileSync(path.join(auditPath, 'unmatched_specs.txt'),
                        `ID: ${v.id}\nUnmatched:\n${v.unmatchedSpecs.join('\n')}\n\n`);
                }
            }
        }
    }
}

async function retryFailedExtractions(context, currentModel, auditPath) {
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
                fs.appendFileSync(path.join(auditPath, 'raw_vehicle_data.txt'),
                    JSON.stringify({ url: fullUrl, data: vehicleData }, null, 2) + '\n\n');
            }

            vehicleData.id = vehicleId;
            const enriched = evaluateSpecs(vehicleData);
            enriched.timestamp = new Date().toISOString();

            const output = loadJSON(`output_${currentModel.replace(/\s+/g, '_')}.json`) || [];
            output.push(enriched);
            saveJSON(`output_${currentModel.replace(/\s+/g, '_')}.json`, output);

            console.log(`✅ Retry successful for ${vehicleId}`);
        } catch (err) {
            console.warn(`❌ Retry failed for ${vehicleId}: ${err.message}`);
            fs.appendFileSync('data/permanent_failures.txt', `${vehicleId} — ${fullUrl}\n`);
            fs.appendFileSync(path.join(auditPath, 'extractor_errors.txt'),
                `URL: ${fullUrl}\nError: ${err.message}\n\n`);
        }
    }

    await retryPage.close();
    fs.unlinkSync('data/reprocess_queue.txt');

    // ✅ Restart logic goes here
    const models = ['X5', 'X3', '3 Series', '5 Series'];
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
    const { browser, context, page } = await setupBrowser();

    try {
        if (auditMode) {
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

        console.log(`📗 Loaded ${seen.size} seen vehicle IDs`);
        console.log(`📘 Loaded ${seenRegistrations.size} seen registrations`);


        const { reconcileOutputLog, archiveRemovedVehicles } = require('./utils/logManager');

        const outputPath = path.join('data', `output_${currentModel.replace(/\s+/g, '_')}.json`);
        const removedPath = path.resolve('audit', 'removed_vehicles.json');
        const results = [];

        const { finalLog, removed } = reconcileOutputLog(results, outputPath);
        archiveRemovedVehicles(removed, removedPath);

        fs.writeFileSync(outputPath, JSON.stringify(finalLog, null, 2));

        if (verboseMode) {
            console.log(`🧮 Updated missingCount for ${finalLog.length + removed.length} vehicles`);
            console.log(`🗑️ Removed ${removed.length} vehicles from output.json`);
        }

        const seenVehicles = new Map();
        const detailPage = await context.newPage();

        const crypto = require('crypto');
        const seenHashes = new Set();
        let pageNumber = 1;
        let hasNextPage = true;
        let exitReason = 'Completed normally';

        const withTimeout = async (fn, ms = 15000) => {
            return Promise.race([
                fn(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Extractor timeout')), ms))
            ]);
        };

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

            try {
                pageData = await withTimeout(() =>
                    scrapePage(page, detailPage, context, {
                        pageNumber,
                        expectedPages,
                        expectedCount,
                        seen,
                        seenVehicles,
                        results,
                        seenRegistrations,
                        currentModel,
                        auditPath
                    }), 15000
                );
            } catch (err) {
                console.error(`❌ Error scraping page ${pageNumber}:`, err);

                if (auditMode) {
                    const failPath = path.resolve(auditPath, `fail_page_${pageNumber}.txt`);
                    fs.writeFileSync(failPath, `Failed at ${new Date().toISOString()}\n${err.stack}`);
                }

                try {
                    if (!detailPage.isClosed?.()) {
                        await detailPage.screenshot({ path: `fail_page_${pageNumber}.png` });
                    }
                } catch (screenshotErr) {
                    console.warn(`⚠️ Screenshot failed: ${screenshotErr.message}`);
                }

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
/*
        // Reconcile output.json with current results
        const outputPath = path.join('data', `output_${currentModel.replace(/\s+/g, '_')}.json`);
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
        */

        /*
        const finalLog = updatedLog.filter(v => v.missingCount < 2);
        fs.writeFileSync(outputPath, JSON.stringify(finalLog, null, 2));

        // Archive removed vehicles
        const removed = updatedLog.filter(v => v.missingCount >= 2);
        const removedPath = path.resolve('audit', 'removed_vehicles.json');
        let archive = [];

        if (fs.existsSync(removedPath)) {
            archive = JSON.parse(fs.readFileSync(removedPath, 'utf-8'));
        }
*/
        const now = new Date().toISOString();
        archive.push(...removed.map(v => ({ ...v, removedAt: now })));
        fs.writeFileSync(removedPath, JSON.stringify(archive, null, 2));

        if (verboseMode) {
            console.log(`🧮 Updated missingCount for ${updatedLog.length} vehicles`);
            console.log(`🗑️ Removed ${removed.length} vehicles from output.json`);
        }

        await finaliseRun({ seen, results, seenVehicles, expectedCount, currentModel, auditPath, auditMode, verboseMode });
        await retryFailedExtractions(context, currentModel, auditPath);

        saveJSON(seenPath, Array.from(seen));
        saveJSON(seenRegPath, Array.from(seenRegistrations));

        console.log(`📕 Saved ${seen.size} seen vehicle IDs`);
        console.log(`📙 Saved ${seenRegistrations.size} seen registrations`);

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
            const restartLogPath = path.resolve(process.cwd(), path.join(auditPath, 'restart_log.txt'));
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