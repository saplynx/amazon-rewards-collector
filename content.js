// Content script for Amazon Rewards Coupon Collector

let isCollecting = false;

/**
 * Find all uncollected reward/coupon buttons
 */
function findCollectButtons() {
    const candidateElements = document.querySelectorAll(
        'button, [role="button"], input[type="button"], a.a-button-text, .a-button-inner'
    );

    const validButtons = [];

    for (const el of candidateElements) {
        // Skip invisible or disabled elements
        if (!el || el.offsetParent === null || el.disabled || el.getAttribute('aria-disabled') === 'true') {
            continue;
        }

        const rawText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();

        // Check if button text matches collect actions
        const isCollect = (
            rawText === 'collect now' ||
            rawText === 'collect offer' ||
            rawText === 'collect' ||
            (rawText.startsWith('collect') && !rawText.includes('collected') && !rawText.includes('collection'))
        );

        if (isCollect) {
            // Find clickable target: button itself or closest button
            const clickable = el.tagName.toLowerCase() === 'button' ? el : (el.closest('button') || el);
            if (!validButtons.includes(clickable)) {
                validButtons.push(clickable);
            }
        }
    }

    return validButtons;
}

/**
 * Perform coupon collection with dynamic loading and safety delays
 */
async function collectAllCoupons() {
    if (isCollecting) {
        return;
    }

    isCollecting = true;
    console.log('Collecting available coupons...');

    // Scroll slightly down to trigger lazy loading of rewards cards
    window.scrollBy({ top: 300, behavior: 'smooth' });
    await new Promise(r => setTimeout(r, 1000));

    // Poll for buttons to appear in case they are still rendering
    let collectButtons = findCollectButtons();
    let retries = 0;
    while (collectButtons.length === 0 && retries < 6) {
        await new Promise(r => setTimeout(r, 1000));
        window.scrollBy({ top: 200, behavior: 'smooth' });
        collectButtons = findCollectButtons();
        retries++;
    }

    if (collectButtons.length === 0) {
        isCollecting = false;
        console.log('All available coupons collected.');
        chrome.runtime.sendMessage({
            action: 'collectionFinished',
            count: 0,
            message: 'All available coupons collected.'
        }).catch(() => {});
        return;
    }

    let collectedCount = 0;

    // Notify background of total found coupons
    chrome.runtime.sendMessage({
        action: 'collectionProgress',
        current: 0,
        total: collectButtons.length,
        sessionCollected: 0
    }).catch(() => {});

    for (let i = 0; i < collectButtons.length; i++) {
        const button = collectButtons[i];

        // Double check button wasn't already collected in a previous iteration
        const currentText = (button.innerText || button.textContent || '').trim().toLowerCase();
        if (currentText.includes('collected')) {
            continue;
        }

        console.log(`Collecting coupons... (${i + 1}/${collectButtons.length})`);

        // Scroll button into view smoothly
        button.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(r => setTimeout(r, 300));

        // Click the button
        button.click();
        collectedCount++;

        // Notify background of live progress
        chrome.runtime.sendMessage({
            action: 'collectionProgress',
            current: i + 1,
            total: collectButtons.length,
            sessionCollected: collectedCount
        }).catch(() => {});

        // Safety delay between clicks (2000ms) to avoid rate limiting
        await new Promise(r => setTimeout(r, 2000));
    }

    isCollecting = false;
    console.log('All available coupons collected.');

    chrome.runtime.sendMessage({
        action: 'collectionFinished',
        count: collectedCount,
        message: 'All available coupons collected.'
    }).catch(() => {});
}

// Listen for messages from background or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'collectCoupons') {
        collectAllCoupons();
        sendResponse({ status: 'started' });
    }
    return true;
});