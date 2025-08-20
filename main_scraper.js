const { chromium } = require('playwright');

(async () => {
    const isCI = process.env.CI === 'true';
    const browser = await chromium.launch({ headless: isCI });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        console.log('Navigating to BMW Approved Used site...');
        await page.goto('https://usedcars.bmw.co.uk/');

        // Reject cookies
        await page.waitForSelector('button:has-text("Reject")', { timeout: 10000 });
        await page.click('button:has-text("Reject")');
        console.log('✅ Cookies rejected');
        await page.waitForTimeout(1000);

        // Select Series: X Series
        await page.click('#series');
        await page.waitForTimeout(1000);
        for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        console.log('✅ Selected X Series');

        await page.waitForTimeout(500);
        await page.mouse.click(0, 0); // Dismiss dropdown

        // Select Model: X5
        await page.click('#body_style');
        await page.waitForTimeout(500);
        for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        console.log('✅ Selected X5');

        await page.screenshot({ path: 'debug-after-selection.png' });

        await page.waitForSelector('button.uvl-c-expected-results-btn', { timeout: 10000 });
        await page.click('button.uvl-c-expected-results-btn');
        console.log('✅ Search button clicked');

        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);

        await page.waitForSelector('button[data-tracking-effect="Additional filters"]', { state: 'visible' });
        await page.click('button[data-tracking-effect="Additional filters"]');
        console.log('✅ Clicked Additional Filters button');
        await page.waitForTimeout(1000);

        await page.locator('a.rc-collapse-header:has-text("Model variant")').click();
        console.log('✅ Expanded Model variant filter');
        await page.waitForTimeout(1000);

        await page.locator('span.uvl-c-select__placeholder', { hasText: 'Engine derivatives' }).click();

        // ✅ Wait for dropdown to appear
        await page.waitForSelector('#variant .react-select-option', { timeout: 10000 });
        await page.screenshot({ path: 'engine-dropdown-visible.png' });

        // 🧭 Scroll and select "50e"
        await page.evaluate(() => {
            const menu = document.querySelector('#react-select-7-listbox');
            if (menu) menu.scrollTop = menu.scrollHeight;
        });

        const variant50e = page.locator('#variant >> .react-select-option:has-text("50e")');
        await variant50e.waitFor({ state: 'visible', timeout: 5000 });
        await variant50e.click();
        console.log('✅ Selected variant: 50e');

        // 🧪 DOM hierarchy debug for "40d"
        const DEBUG_HIERARCHY = false;
        if (DEBUG_HIERARCHY)
        {
            const locator = page.locator('text="40d"');
            const count = await locator.count();

            for (let i = 0; i < count; i++)
            {
                const handle = await locator.nth(i).elementHandle();
                const parent = await handle.evaluate(node => {
                    let current = node;
                    const hierarchy = [];
                    while (current && current.parentElement) {
                        current = current.parentElement;
                        hierarchy.push({
                            tag: current.tagName,
                            class: current.className,
                            id: current.id
                        });
                    }
                    return hierarchy;
                });
                console.log(`📦 Parent hierarchy for match ${i}:`, parent);
            }
        }

        await page.waitForTimeout(2000);

        // Wait for the updated "Show X cars" button to appear
        await page.waitForSelector('button.uvl-c-expected-results-btn', { timeout: 10000 });

        // Optional: Log the button text to confirm it's updated
        const buttonText = await page.locator('button.uvl-c-expected-results-btn').innerText();
        console.log(`🔄 Updated search button text: "${buttonText}"`);

        // Click the button to trigger the filtered search
        await page.click('button.uvl-c-expected-results-btn');
        console.log('✅ Final search triggered with engine derivative');

        await page.waitForTimeout(5000);

        await page.screenshot({ path: 'post-search-results.png' });
        console.log('📸 Screenshot taken after final search');


        // Wait for listings to load
        await page.waitForSelector('a.uvl-c-advert__media-link[href*="/vehicle/"]', { timeout: 10000 });
        console.log('✅ Listings loaded');

        await page.waitForTimeout(2000);

        const listingLinks = await page.locator('a.uvl-c-advert__media-link[href*="/vehicle/"]');
        const count = await listingLinks.count();
        console.log(`🔍 Found ${count} vehicle listing links`);

        if (count === 0)
        {
            console.log('⚠️ No listings found — check if the page loaded correctly or if cookies blocked rendering');
        }

        await listingLinks.first().click();
        console.log('🚗 Navigated to first vehicle detail page');

        const visibleStandard = page.locator('text=Standard features').filter({ hasText: 'Standard features', isVisible: true });
        const count2 = await visibleStandard.count();
        console.log(`🔍 Found ${count2} visible "Standard features" elements`);

        await page.locator('text=Standard features').first().waitFor({ timeout: 10000 });

        const standardCount = await page.locator('text=Standard features').count();
        console.log(`🔍 Found ${standardCount} elements containing "Standard features"`);

        const allStandard = page.locator('text=Standard features');
        const total = await allStandard.count();

        await visibleStandard.first().waitFor({ timeout: 10000 });
        console.log('📍 Standard features section found — detail page confirmed');

        for (let i = 0; i < total; i++)
        {
            const isVisible = await allStandard.nth(i).isVisible();
            const html = await allStandard.nth(i).evaluate(el => el.outerHTML);
            console.log(`🔍 Match ${i} — Visible: ${isVisible}\n${html}\n`);
        }

        const fs = require('fs');

        // Get the full HTML content of the current page
        const html = await page.content();

        // Save it to a local file
        fs.writeFileSync('bmw-x5-dump.html', html);

        console.log('✅ HTML dump saved to bmw-x5-dump.html');

        const { loadJSON, saveJSON } = require('./utils/file_manager');

        // Simulate extracting vehicle ID from URL
        const url = page.url();
        const vehicleIdMatch = url.match(/vehicle\/([^\/]+)/);
        const vehicleId = vehicleIdMatch ? vehicleIdMatch[1] : `unknown-${Date.now()}`;

        // Simulate extracted data
        const vehicleData = {
            id: vehicleId,
            title: await page.title(),
            url,
            timestamp: new Date().toISOString()
        };

        // Load seen vehicles
        const seen = new Set(loadJSON('seen_vehicles.json') || []);
        if (seen.has(vehicleData.id))
        {
            console.log(`⏩ Vehicle ${vehicleData.id} already seen — skipping save`);
        }
        else
        {
            console.log(`💾 New vehicle found: ${vehicleData.id} — saving`);
            const output = loadJSON('output.json') || [];
            output.push(vehicleData);
            saveJSON('output.json', output);

            seen.add(vehicleData.id);
            saveJSON('seen_vehicles.json', Array.from(seen));
        }


        await page.waitForTimeout(5000);



    } catch (err) {
        console.error('❌ Error:', err);
        await page.screenshot({ path: 'error-screenshot.png' });
    } finally {
        await browser.close();
    }
})();