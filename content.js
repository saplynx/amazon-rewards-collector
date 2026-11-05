// Content script for Amazon Rewards Coupon Collector
// Preserves 34f271b working mechanism with manual human-like actions and complete state management

let isCollecting = false;
let abortRequested = false;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Safe runtime messaging guard to prevent exceptions if extension context unloads
 */
function safeSendMessage(payload) {
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
            chrome.runtime.sendMessage(payload).catch(() => {});
        }
    } catch (e) {}
}

/**
 * Generate a random integer delay between min and max (inclusive) for natural human jitter
 */
function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Wait until the page finishes loading completely and reward containers are rendered
 * before starting any actions.
 */
async function waitForPageToLoad() {
    console.log('Waiting for rewards page to finish loading before starting actions...');
    safeSendMessage({
        action: 'collectionProgress',
        current: 0,
        total: 0,
        sessionCollected: 0,
        message: 'Waiting for rewards page to finish loading...'
    });

    // 1. Wait for document.readyState === 'complete'
    if (document.readyState !== 'complete') {
        await new Promise((resolve) => {
            const onLoad = () => {
                window.removeEventListener('load', onLoad);
                resolve();
            };
            window.addEventListener('load', onLoad);
            setTimeout(resolve, 8000); // safety fallback
        });
    }

    // 2. Poll for primary reward elements / containers to be present in the DOM
    const startWait = Date.now();
    const MAX_WAIT_MS = 10000;
    const REWARD_CONTAINER_SELECTORS = [
        '#rewards-grid',
        '.rewards-banner',
        '.coupons-wrap',
        '.a-carousel',
        'tux-slider',
        '.carousel-scroller-card-list-container',
        '[data-coupon-id]',
        '[id^="amzn1.rewards.reward"]',
        '.rh-offer-card',
        '.rh-rewards-banner',
        'button, [role="button"]'
    ].join(', ');

    while (Date.now() - startWait < MAX_WAIT_MS && !abortRequested) {
        const found = document.querySelector(REWARD_CONTAINER_SELECTORS);
        if (found) {
            break;
        }
        await sleep(250);
    }

    // 3. Wait for initial skeleton screens / loading spinners to resolve
    await waitForListItemsToSettle(document, 4000);

    // 4. Natural settle delay (hydration / late-script settlement)
    await sleep(getRandomDelay(1200, 1800));
    console.log('Page load complete. Starting actions.');
}

/**
 * Wait for active loading indicators to disappear and list items to settle
 * before triggering the next scroll.
 */
async function waitForListItemsToSettle(container = document, maxWaitMs = 1500) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs && !abortRequested) {
        // Check for active spinners, skeletons, or placeholder cards inside the container
        const loaders = container.querySelectorAll(
            '.a-spinner:not(.a-hidden), .loading-spinner, .a-skeleton, .skeleton-card, [data-loading="true"], .shimmer'
        );
        let hasVisibleLoader = false;
        for (const l of loaders) {
            if (l.offsetParent !== null || l.offsetWidth > 0 || l.offsetHeight > 0) {
                hasVisibleLoader = true;
                break;
            }
        }
        if (!hasVisibleLoader) {
            // No visible loaders remaining
            break;
        }
        await sleep(150);
    }
}

/**
 * Find all uncollected reward/coupon buttons (faithful to 34f271b working mechanism)
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

        // Avoid unrevealed scratch cards or external partner referral links
        if (el.closest('.sc-hidden, .sc-cover-container, .claimed-state, .expired-state')) {
            continue;
        }
        const link = el.tagName.toLowerCase() === 'a' ? el : el.closest('a');
        if (link && (link.target === '_blank' || (link.href && (link.href.includes('dest=') || link.href.includes('/r?aid='))))) {
            continue;
        }

        const rawText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();

        // Check if button text matches collect actions (exact 34f271b matching)
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
 * Check if button has already been collected or clicked in this session
 */
function isAlreadyCollected(button) {
    if (!button) return true;
    if (button.dataset.arcCollected === 'true') return true;

    const currentText = (button.innerText || button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (currentText.includes('collected') || currentText.includes('claimed') || currentText.includes('redeem')) {
        return true;
    }

    return false;
}

/**
 * Expand fragment "Load more" or pagination buttons if present and wait for items to mount
 */
async function expandLoadMoreButtons() {
    const moreButtons = document.querySelectorAll(
        '.fragment-load-more-button, .fragment-load-more-button input, .fragment-load-more-button .a-button-text, button[data-action="load-more"], a[data-action="load-more"]'
    );
    for (const btn of moreButtons) {
        if (btn && btn.dataset.arcExpanded !== 'true') {
            btn.dataset.arcExpanded = 'true';
            try {
                btn.click();
                // Wait for the newly fetched items to mount
                await sleep(getRandomDelay(500, 800));
                await waitForListItemsToSettle(document, 1500);
            } catch (e) {}
        }
    }
}

/**
 * Phase 1: Scroll all the way to the bottom with natural manual gestures,
 * ensuring newly revealed list items/shelves load before the next scroll.
 */
async function manualScrollToBottom(isTimeUp) {
    console.log('Phase 1: Manual scrolling to bottom to trigger lazy loading...');
    let lastScrollY = -1;
    let stuckCount = 0;
    let lastProgressReport = Date.now();

    while (!abortRequested && (!isTimeUp || !isTimeUp())) {
        const docHeight = Math.max(document.body.scrollHeight || 0, document.documentElement.scrollHeight || 0);
        const currentScroll = window.scrollY + window.innerHeight;

        // Keep watchdog timer active with live progress updates
        if (Date.now() - lastProgressReport > 3000) {
            safeSendMessage({
                action: 'collectionProgress',
                current: 0,
                total: 0,
                sessionCollected: 0,
                message: 'Loading rewards (scrolling to bottom)...'
            });
            lastProgressReport = Date.now();
        }

        // Expand any load-more fragment buttons encountered along the way
        await expandLoadMoreButtons();

        // Human-like scroll step with randomized distance (280px - 440px)
        const scrollStep = getRandomDelay(280, 440);
        window.scrollBy({ top: scrollStep, behavior: 'smooth' });

        // Wait for list items and dynamic shelves to load before the next scroll
        await waitForListItemsToSettle(document, 1500);

        // Natural human pause before the next scroll step (400ms - 700ms)
        await sleep(getRandomDelay(400, 700));

        // Detect reaching bottom or stuck
        if (window.scrollY === lastScrollY) {
            stuckCount++;
            if (currentScroll >= docHeight - 60) {
                // Wait to see if infinite scroll loads more content
                await sleep(getRandomDelay(800, 1200));
                await waitForListItemsToSettle(document, 2000);
                const newDocHeight = Math.max(document.body.scrollHeight || 0, document.documentElement.scrollHeight || 0);
                if (newDocHeight > docHeight + 60) {
                    stuckCount = 0;
                    continue;
                } else if (stuckCount >= 2) {
                    break; // Confirmed bottom
                }
            } else if (stuckCount >= 3) {
                break;
            }
        } else {
            stuckCount = 0;
            lastScrollY = window.scrollY;
        }
    }
}

/**
 * Phase 2: Scroll each horizontal list / carousel till the end,
 * ensuring newly revealed items/cards load before the next scroll.
 */
async function manualScrollEachList(isTimeUp) {
    console.log('Phase 2: Scrolling each horizontal list / carousel till the end...');
    const carousels = document.querySelectorAll(
        '.coupons-wrap, .carousel-scroller-card-list-container, [role="list"].remove-scrollbars, .a-carousel, tux-slider, .a-carousel-viewport'
    );

    let lastProgressReport = Date.now();

    for (let i = 0; i < carousels.length; i++) {
        if (abortRequested || (isTimeUp && isTimeUp())) break;

        const c = carousels[i];

        // Keep watchdog timer active
        if (Date.now() - lastProgressReport > 3000) {
            safeSendMessage({
                action: 'collectionProgress',
                current: 0,
                total: 0,
                sessionCollected: 0,
                message: `Expanding reward carousels (${i + 1}/${carousels.length})...`
            });
            lastProgressReport = Date.now();
        }

        // Scroll carousel into view naturally
        try {
            c.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sleep(getRandomDelay(180, 300));
        } catch (e) {}

        // Ensure visible carousel items have settled
        await waitForListItemsToSettle(c, 1200);

        // Scroll native horizontal overflow rail incrementally till the end (skip desktop AUI viewports which use transforms)
        const computedOverflow = window.getComputedStyle(c).overflowX;
        const isNativeScrollable = (computedOverflow === 'auto' || computedOverflow === 'scroll') && !c.classList.contains('a-carousel-viewport');

        if (isNativeScrollable && c.scrollWidth > c.clientWidth + 15) {
            const maxScrollLeft = c.scrollWidth - c.clientWidth;
            let currentLeft = c.scrollLeft;

            while (currentLeft < maxScrollLeft && !abortRequested && (!isTimeUp || !isTimeUp())) {
                // Natural swipe distance (~65% to 85% of visible client width)
                const swipeStep = Math.min(
                    getRandomDelay(Math.floor(c.clientWidth * 0.65), Math.floor(c.clientWidth * 0.85)),
                    maxScrollLeft - currentLeft
                );
                currentLeft += swipeStep;
                c.scrollTo({ left: currentLeft, behavior: 'smooth' });

                // Wait for newly revealed list items/cards to load before next horizontal scroll
                await waitForListItemsToSettle(c, 1500);

                // Natural human pause before next swipe
                await sleep(getRandomDelay(450, 700));
            }
        }

        // If desktop AUI carousel with next button, advance page by page
        const container = c.closest('.a-carousel-container') || c;
        const nextBtn = container.querySelector('.a-carousel-goto-nextpage, .a-carousel-right');
        if (nextBtn && !nextBtn.classList.contains('a-disabled')) {
            for (let page = 0; page < 6; page++) {
                if (abortRequested || (isTimeUp && isTimeUp()) || nextBtn.classList.contains('a-disabled')) break;

                try {
                    nextBtn.click();
                } catch (e) {}

                // Wait for AUI carousel transition animation to finish
                const transitionStart = Date.now();
                while (Date.now() - transitionStart < 1000 && !abortRequested) {
                    if (!container.classList.contains('a-carousel-transitioning') && !c.classList.contains('a-carousel-transitioning')) {
                        break;
                    }
                    await sleep(100);
                }

                // Wait for the new page's list items to render and settle before next scroll/page
                await waitForListItemsToSettle(container, 1500);

                // Human pause between pages before next click
                await sleep(getRandomDelay(480, 750));
            }
        }
    }
}

/**
 * Simulate a realistic manual human tap / click on a button
 */
async function manualClick(button) {
    if (!button) return;

    // 1. Scroll into view smoothly (centered vertically and horizontally)
    try {
        button.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    } catch (e) {
        button.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Natural human gaze / settle hesitation (220ms - 380ms)
    await sleep(getRandomDelay(220, 380));

    // Calculate natural coordinates with jitter (within 30% to 70% of button bounds)
    const rect = button.getBoundingClientRect();
    const jitterX = rect.width * (0.3 + Math.random() * 0.4);
    const jitterY = rect.height * (0.3 + Math.random() * 0.4);
    const clientX = Math.round(rect.left + Math.max(2, Math.min(rect.width - 2, jitterX)));
    const clientY = Math.round(rect.top + Math.max(2, Math.min(rect.height - 2, jitterY)));

    const eventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        screenX: window.screenX + clientX,
        screenY: window.screenY + clientY
    };

    // 2. Hover / enter simulation
    button.dispatchEvent(new PointerEvent('pointerover', { ...eventInit, pointerType: 'touch' }));
    button.dispatchEvent(new PointerEvent('pointerenter', { ...eventInit, pointerType: 'touch' }));
    button.dispatchEvent(new MouseEvent('mouseover', eventInit));
    button.dispatchEvent(new MouseEvent('mouseenter', eventInit));
    await sleep(getRandomDelay(40, 80));

    // 3. Touch / mouse down
    button.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerType: 'touch', isPrimary: true, button: 0 }));
    button.dispatchEvent(new MouseEvent('mousedown', { ...eventInit, button: 0, buttons: 1 }));

    // Hold duration (50ms - 95ms)
    await sleep(getRandomDelay(50, 95));

    // 4. Touch / mouse up
    button.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, pointerType: 'touch', isPrimary: true, button: 0 }));
    button.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, button: 0, buttons: 0 }));

    // 5. Native click execution
    try {
        button.click();
    } catch (e) {
        button.dispatchEvent(new MouseEvent('click', { ...eventInit, button: 0, buttons: 0 }));
    }
}

/**
 * Main collection controller:
 * 1. Wait for page to finish loading completely before starting actions
 * 2. Manually scroll to bottom, ensuring list items load before each scroll
 * 3. Manually scroll each horizontal list till the end, waiting for items before each scroll
 * 4. Smoothly scroll back to top and settle
 * 5. Manually click each collect button with realistic jitter, pauses, and live progress state
 */
async function collectAllCoupons() {
    if (isCollecting) {
        return;
    }

    isCollecting = true;
    abortRequested = false;
    console.log('Starting coupon collection with manual human-like actions...');

    let collectedCount = 0;
    const startTime = Date.now();
    const MAX_DURATION_MS = 175000;
    const isTimeUp = () => (Date.now() - startTime) >= MAX_DURATION_MS;

    // Step 0: Ensure page has completely finished loading before starting actions
    await waitForPageToLoad();

    if (abortRequested || isTimeUp()) {
        finishCollection(collectedCount, startTime);
        return;
    }

    // Phase 1: Scroll all the way to bottom to load all 'load on scroll' / paginated data
    safeSendMessage({
        action: 'collectionProgress',
        current: 0,
        total: 0,
        sessionCollected: 0,
        message: 'Loading rewards (scrolling to bottom)...'
    });

    await manualScrollToBottom(isTimeUp);

    if (abortRequested || isTimeUp()) {
        finishCollection(collectedCount, startTime);
        return;
    }

    // Phase 2: Scroll each list/carousel till the end, waiting for items to load before each scroll
    safeSendMessage({
        action: 'collectionProgress',
        current: 0,
        total: 0,
        sessionCollected: 0,
        message: 'Expanding reward carousels...'
    });

    await manualScrollEachList(isTimeUp);

    if (abortRequested || isTimeUp()) {
        finishCollection(collectedCount, startTime);
        return;
    }

    // Phase 3: Smoothly scroll back to top and wait for settle
    safeSendMessage({
        action: 'collectionProgress',
        current: 0,
        total: 0,
        sessionCollected: 0,
        message: 'Starting coupon collection...'
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(getRandomDelay(500, 800));
    await waitForListItemsToSettle(document, 1500);

    // Phase 4: Find and manually click all available collect buttons
    const allButtons = findCollectButtons();
    console.log(`Found ${allButtons.length} collect buttons after full discovery.`);

    safeSendMessage({
        action: 'collectionProgress',
        current: 0,
        total: allButtons.length,
        sessionCollected: 0,
        message: `Collecting coupons (0 of ${allButtons.length})...`
    });

    for (let i = 0; i < allButtons.length; i++) {
        if (abortRequested || isTimeUp()) break;

        const button = allButtons[i];
        if (isAlreadyCollected(button)) {
            continue;
        }

        console.log(`Manually clicking coupon ${collectedCount + 1}/${allButtons.length}: ${button.innerText?.trim() || button.id}`);

        // Perform realistic manual tap/click simulation
        await manualClick(button);
        button.dataset.arcCollected = 'true';
        collectedCount++;

        // Live progress reporting
        safeSendMessage({
            action: 'collectionProgress',
            current: collectedCount,
            total: allButtons.length,
            sessionCollected: collectedCount,
            message: `Collecting coupon ${collectedCount} of ${allButtons.length}...`
        });

        // Realistic human interval between clicks (500ms - 850ms)
        await sleep(getRandomDelay(500, 850));
    }

    // Verification check: sweep any late-rendered items
    if (!abortRequested && !isTimeUp()) {
        const remaining = findCollectButtons().filter(btn => !isAlreadyCollected(btn));
        if (remaining.length > 0) {
            console.log(`Verification: Found ${remaining.length} late-rendered coupons...`);
            for (let i = 0; i < remaining.length; i++) {
                if (abortRequested || isTimeUp()) break;
                const button = remaining[i];
                if (isAlreadyCollected(button)) continue;

                await manualClick(button);
                button.dataset.arcCollected = 'true';
                collectedCount++;

                safeSendMessage({
                    action: 'collectionProgress',
                    current: collectedCount,
                    total: collectedCount,
                    sessionCollected: collectedCount,
                    message: `Collecting coupon ${collectedCount}...`
                });

                await sleep(getRandomDelay(500, 800));
            }
        }
    }

    finishCollection(collectedCount, startTime);
}

/**
 * Conclude collection and send final state message
 */
function finishCollection(collectedCount, startTime) {
    isCollecting = false;
    const finishedMessage = abortRequested
        ? 'Collection stopped.'
        : `All available coupons collected (${collectedCount} total).`;

    console.log(`Collection complete. Total collected: ${collectedCount} in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    safeSendMessage({
        action: 'collectionFinished',
        count: collectedCount,
        message: finishedMessage
    });
}

// Message listeners for collection and stop actions
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
