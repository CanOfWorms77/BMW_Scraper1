const fs = require('fs');
const path = require('path');

async function captureAuditArtifacts(page, vehicleId, auditPath, error) {

    if (!fs.existsSync(auditPath)) {
        fs.mkdirSync(auditPath, { recursive: true });
    }

    try {
        const html = await page.content();
        fs.writeFileSync(path.join(auditPath, `fail_dom_${vehicleId}.html`), html);

        const bodyText = await page.evaluate(() => document.body.innerText);
        fs.writeFileSync(path.join(auditPath, `fail_text_${vehicleId}.txt`), bodyText);

        const selectors = [
            '.vehicle-details',
            '.specification',
            '[data-component="vehicle-specs"]'
        ];

        for (const selector of selectors) {
            const exists = await page.$(selector);
            fs.appendFileSync(
                path.join(auditPath, `selector_check_${vehicleId}.txt`),
                `${selector}: ${exists ? '✅ found' : '❌ missing'}\n`
            );
        }

        await page.screenshot({
            path: path.join(auditPath, `fail_page_${vehicleId}.png`)
        });

        fs.appendFileSync(
            path.join(auditPath, 'fail_log.txt'),
            `${new Date().toISOString()} — Vehicle ${vehicleId} failed: ${error.message}\n`
        );
    } catch (auditErr) {
        console.warn(`⚠️ Failed to capture audit artifacts: ${auditErr.message}`);
    }
}

module.exports = { captureAuditArtifacts };
