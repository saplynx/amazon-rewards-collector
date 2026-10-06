// Content script for Amazon Rewards Coupon Collector

let isCollecting = false;
let abortRequested = false;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Generate a random integer delay between min and max (inclusive) for natural human jitter
 */
function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a unique tracking key for a coupon button to avoid duplicate clicks
 */
function getButtonKey(button) {
    if (!button) return '';
    const couponId = button.getAttribute('data-coupon-id') ||
                     button.closest('[data-coupon-id]')?.getAttribute('data-coupon-id') ||
                     (button.id && button.id.startsWith('amzn1.rewards.reward.') ? button.id : null);
    if (couponId) return couponId;

    const rect = button.getBoundingClientRect();
    const text = (button.innerText || button.textContent || '').trim();
    return `${text}_${Math.round(rect.top + window.scrollY)}_${Math.round(rect.left + window.scrollX)}`;
}

/**
 * Query DOM recursively including shadow roots if present
 */
function querySelectorAllDeep(selector, root = document) {
    const results = Array.from(root.querySelectorAll(selector));
    const all = root.querySelectorAll('*');
    for (const el of all) {
        if (el.shadowRoot) {
            results.push(...querySelectorAllDeep(selector, el.shadowRoot));
        }
    }
    return results;
}

/**
 * Check if a button has already been clicked, collected, or claimed
 */
function isCollectedOrClicked(button, clickedKeys) {
    if (!button) return true;
    if (button.dataset.arcCollected === 'true') return true;

    const parentBtn = button.closest('.a-button');
    if (parentBtn && parentBtn.dataset.arcCollected === 'true') return true;

    // Check if within unclaimed container that is marked hidden
    const unclaimed = button.closest('.unclaimed-state');
    if (unclaimed && unclaimed.classList.contains('hidden')) return true;

    // Check if within CTA section where claimed-state is active and not hidden
    const cta = button.closest('.cta-section');
    if (cta) {
        const claimed = cta.querySelector('.claimed-state');
        if (claimed && !claimed.classList.contains('hidden')) return true;
    }

    const key = getButtonKey(button);
    if (key && clickedKeys.has(key)) return true;

    const currentText = (button.innerText || button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (
        currentText.includes('collected') ||
        currentText.includes('view offer') ||
        currentText.includes('redeem') ||
        currentText.includes('shop now') ||
        currentText.includes('buy now') ||
        currentText.includes('order now') ||
        currentText.includes('unlocked') ||
        currentText.includes('available to use')
    ) {
        return true;
    }

    return false;
}

/**
 * Find all uncollected reward/coupon buttons currently present in the DOM.
 * Targets actual action elements without matching parent wrappers.
 */
function findCollectButtons() {
    const candidateElements = querySelectorAllDeep(
        'button.a-button-text, button[id^="amzn1.rewards.reward."], button[data-coupon-id], .offer-cta button, a.a-button-text, a.coupon-action-btn, a[data-action="collect"], .collect-coupon-btn button, .collect-coupon-btn a'
    );

    const validButtons = [];

    for (const el of candidateElements) {
        if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') {
            continue;
        }

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') {
            continue;
        }

        const rawText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();

        const isCollect = (
            rawText === 'collect now' ||
            rawText === 'collect offer' ||
            rawText === 'collect' ||
            (rawText.startsWith('collect') && !rawText.includes('collected') && !rawText.includes('collection'))
        );

        if (isCollect && !validButtons.includes(el)) {
            validButtons.push(el);
        }
    }

    return validButtons;
}

/**
 * Scroll horizontally and vertically to center the target coupon in view
 */
async function scrollToCoupon(button) {
    if (!button) return;

    // 1. Center the button smoothly in the viewport (block: vertical, inline: horizontal)
    try {
        button.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
            inline: 'center'
        });
    } catch (e) {
        try {
            button.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (err) {}
    }

    // 2. Also ensure any scrollable horizontal parent container (e.g. mobile carousel) is aligned
    let parent = button.parentElement;
    while (parent && parent !== document.body) {
        if (parent.scrollWidth > parent.clientWidth + 10) {
            const btnRect = button.getBoundingClientRect();
            const parentRect = parent.getBoundingClientRect();
            if (btnRect.left < parentRect.left + 20 || btnRect.right > parentRect.right - 20) {
                const targetScrollLeft = parent.scrollLeft + (btnRect.left - parentRect.left) - (parentRect.width / 2) + (btnRect.width / 2);
                parent.scrollTo({
                    left: Math.max(0, targetScrollLeft),
                    behavior: 'smooth'
                });
            }
            break;
        }
        parent = parent.parentElement;
    }

    // 3. Human gaze & scroll settle pause (180ms - 320ms)
    await sleep(getRandomDelay(180, 320));
}

/**
 * Simulate human mouse movement, hover, jitter, and click sequence
 */
async function simulateHumanClick(button) {
    if (!button) return;

    button.dataset.arcCollected = 'true';
    const parentBtn = button.closest('.a-button');
    if (parentBtn) parentBtn.dataset.arcCollected = 'true';

    // Calculate natural click target with random jitter (within 25% to 75% of button bounds)
    const rect = button.getBoundingClientRect();
    const jitterX = rect.width * (0.25 + Math.random() * 0.5);
    const jitterY = rect.height * (0.25 + Math.random() * 0.5);
    const clientX = Math.round(rect.left + Math.max(2, Math.min(rect.width - 2, jitterX)));
    const clientY = Math.round(rect.top + Math.max(2, Math.min(rect.height - 2, jitterY)));
    const screenX = window.screenX + clientX;
    const screenY = window.screenY + clientY;

    const baseEventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        screenX,
        screenY
    };

    // 1. Human mouse move & hover
    button.dispatchEvent(new MouseEvent('mousemove', { ...baseEventInit, buttons: 0 }));
    button.dispatchEvent(new MouseEvent('mouseenter', { ...baseEventInit, buttons: 0 }));
    button.dispatchEvent(new MouseEvent('mouseover', { ...baseEventInit, buttons: 0 }));

    // Slight hesitation before press (50ms - 120ms)
    await sleep(getRandomDelay(50, 120));

    // 2. Mouse button down
    button.dispatchEvent(new MouseEvent('mousedown', { ...baseEventInit, button: 0, buttons: 1 }));

    // Human click hold jitter (40ms - 85ms)
    await sleep(getRandomDelay(40, 85));

    // 3. Mouse button release
    button.dispatchEvent(new MouseEvent('mouseup', { ...baseEventInit, button: 0, buttons: 0 }));

    // 4. Click execution
    try {
        button.click();
    } catch (e) {
        button.dispatchEvent(new MouseEvent('click', { ...baseEventInit, button: 0, buttons: 0 }));
    }
}

/**
 * Previous mechanism of scrolling to dynamically trigger lazy loading of all reward cards across the page
 */
async function scrollToLoadAllCoupons(isTimeUp) {
    // 1. Progressively scroll down the page to trigger lazy loading of rewards cards
    const totalHeight = Math.max(document.body.scrollHeight || 4000, document.documentElement.scrollHeight || 4000, 3600);
    const scrollStep = 350;
    for (let pos = scrollStep; pos <= totalHeight; pos += scrollStep) {
        if ((isTimeUp && isTimeUp()) || abortRequested) break;
        window.scrollBy({ top: scrollStep, behavior: 'smooth' });
        await sleep(getRandomDelay(200, 350));
    }

    // 2. Trigger horizontal card carousels so lazy cards render
    const carousels = document.querySelectorAll(
        '.carousel-scroller-card-list-container, [role="list"].remove-scrollbars, .coupons-wrap'
    );
    for (const c of carousels) {
        if (c.scrollWidth > c.clientWidth) {
            c.scrollLeft = c.scrollWidth;
        }
    }

    // 3. Expand fragment buttons if present
    const fragmentButtons = document.querySelectorAll(
        '.fragment-load-more-button, .fragment-load-more-button input, .fragment-load-more-button .a-button-text'
    );
    for (const btn of fragmentButtons) {
        if (btn && btn.dataset.arcExpanded !== 'true') {
            btn.dataset.arcExpanded = 'true';
            try { btn.click(); } catch (e) {}
        }
    }

    // 4. Smoothly scroll back to top with human delay
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(getRandomDelay(400, 600));

    // 5. Polling retry loop if buttons take a moment to render
    let buttons = findCollectButtons();
    let retries = 0;
    while (buttons.length === 0 && retries < 5 && !abortRequested && (!isTimeUp || !isTimeUp())) {
        window.scrollBy({ top: 200, behavior: 'smooth' });
        await sleep(getRandomDelay(600, 900));
        buttons = findCollectButtons();
        retries++;
    }
}

/**
 * Main collection controller with human mouse simulation, horizontal scrolling, and safety bounds
 */
async function collectAllCoupons() {
    if (isCollecting) {
        return;
    }

    isCollecting = true;
    abortRequested = false;
    console.log('Starting Amazon rewards coupon collection with human simulation...');

    const startTime = Date.now();
    const MAX_DURATION_MS = 180000; // 3-minute hard ceiling for overall execution safety
    const isTimeUp = () => (Date.now() - startTime) >= MAX_DURATION_MS;

    chrome.runtime.sendMessage({
        action: 'collectionProgress',
        current: 0,
        total: 0,
        sessionCollected: 0,
        message: 'Scrolling to load all rewards...'
    }).catch(() => {});

    // Execute previous progressive scroll mechanism to trigger lazy-loading
    await scrollToLoadAllCoupons(isTimeUp);

    const clickedKeys = new Set();
    let collectedCount = 0;

    // Up to 2 collection passes (sweep + verify)
    for (let pass = 0; pass < 2; pass++) {
        if (isTimeUp() || abortRequested) break;

        const allButtons = findCollectButtons();
        const uncollected = allButtons.filter(btn => !isCollectedOrClicked(btn, clickedKeys));

        console.log(`Pass ${pass + 1}: Found ${allButtons.length} buttons, ${uncollected.length} uncollected.`);

        if (uncollected.length === 0) {
            break;
        }

        for (let i = 0; i < uncollected.length; i++) {
            if (isTimeUp() || abortRequested) break;

            const button = uncollected[i];
            if (isCollectedOrClicked(button, clickedKeys)) continue;

            const key = getButtonKey(button);
            clickedKeys.add(key);

            // 1. Scroll horizontally and vertically to center the coupon
            await scrollToCoupon(button);
            if (isTimeUp() || abortRequested) break;

            // 2. Perform human-like mouse simulation click with jitter
            await simulateHumanClick(button);
            collectedCount++;

            // 3. Notify extension of progress
            chrome.runtime.sendMessage({
                action: 'collectionProgress',
                current: collectedCount,
                total: Math.max(allButtons.length, collectedCount),
                sessionCollected: collectedCount,
                message: `Collecting coupon ${collectedCount}...`
            }).catch(() => {});

            // 4. Natural human interval before moving to next action (350ms - 650ms)
            await sleep(getRandomDelay(350, 650));
        }

        if (!isTimeUp() && !abortRequested && pass === 0) {
            await sleep(getRandomDelay(400, 700)); // Allow DOM to settle before quick verification pass
        }
    }

    isCollecting = false;
    const finishedMessage = abortRequested
        ? 'Collection stopped.'
        : 'All available coupons collected.';

    console.log(`Collection complete. Total collected: ${collectedCount} in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    chrome.runtime.sendMessage({
        action: 'collectionFinished',
        count: collectedCount,
        message: finishedMessage
    }).catch(() => {});
}

// Message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'collectCoupons') {
        collectAllCoupons();
        sendResponse({ status: 'started' });
        return true;
    }

    if (request.action === 'stopCollection') {
        abortRequested = true;
        isCollecting = false;
        sendResponse({ status: 'stopped' });
        return true;
    }

    return true;
});