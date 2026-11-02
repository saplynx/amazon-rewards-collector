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
 * Resolve unique coupon ID by searching up the DOM and across Shadow DOM boundaries
 */
function getCouponId(el) {
    let curr = el;
    while (curr) {
        const id = curr.getAttribute?.('data-coupon-id') ||
                   (curr.id && curr.id.startsWith('amzn1.rewards.reward.') ? curr.id : null);
        if (id) return id;
        curr = curr.parentElement || (curr.getRootNode && curr.getRootNode() !== document ? curr.getRootNode().host : null);
    }
    return null;
}

/**
 * Check if an element is a valid, active Collect / Claim button
 */
function isCollectButton(el) {
    if (!el) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;

    // Check display/visibility
    if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
    }

    // Exclude invalid container or state classes (e.g. unrevealed scratch cards, claimed cards)
    if (el.closest('.redeem-btn, .claim-code-btn, .claimed-state, .expired-state, .hidden, .sc-hidden, .sc-display-none, .sc-cover-container')) {
        return false;
    }

    // Check if within unclaimed container that is marked hidden
    const unclaimed = el.closest('.unclaimed-state');
    if (unclaimed && (unclaimed.classList.contains('hidden') || unclaimed.style.display === 'none')) {
        return false;
    }

    // Check if within CTA section where claimed-state is active and not hidden
    const cta = el.closest('.cta-section, .offer-cta');
    if (cta) {
        const claimed = cta.querySelector('.claimed-state');
        if (claimed && !claimed.classList.contains('hidden') && claimed.style.display !== 'none') {
            return false;
        }
    }

    // Exclude external third-party merchant links (e.g. boAt, Lenskart target="_blank" with dest=)
    const link = el.tagName.toLowerCase() === 'a' ? el : el.closest('a');
    if (link && (link.target === '_blank' || (link.href && (link.href.includes('dest=') || link.href.includes('/r?aid=') || !link.href.includes('amazon.in'))))) {
        return false;
    }

    const text = (el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim().toLowerCase();

    // Must not be already collected / redeemed / shopping cta
    if (
        text.includes('collected') ||
        text.includes('claimed') ||
        text.includes('already collected') ||
        text.includes('view offer') ||
        text.includes('shop now') ||
        text.includes('buy now') ||
        text.includes('order now') ||
        text.includes('unlocked') ||
        text.includes('available to use') ||
        text.includes('redeem')
    ) {
        return false;
    }

    // Must match collect / claim phrasing
    const matchesCollect = (
        text === 'collect' ||
        text === 'collect now' ||
        text === 'collect offer' ||
        text === 'collect coupon' ||
        text === 'collect reward' ||
        text === 'claim' ||
        text === 'claim now' ||
        text === 'claim offer' ||
        /\b(collect|claim)\b/i.test(text)
    );

    return matchesCollect;
}

/**
 * Find all uncollected reward/coupon buttons currently present in the DOM (including inside shadow roots)
 */
function findCollectButtons(root = document) {
    const candidates = querySelectorAllDeep(
        'button, [role="button"], input[type="button"], input[type="submit"], a.a-button-text, .a-button, .a-button-inner, .offer-cta, [data-action="collect"], .collect-coupon-btn, [data-coupon-id]',
        root
    );

    const validButtons = [];
    for (const el of candidates) {
        // Exclude image wrappers and non-action containers
        if (el.classList && (el.classList.contains('reward-ad-image-click-dp') || el.classList.contains('sc-cover-container'))) {
            continue;
        }

        let target = el;
        if (el.tagName.toLowerCase() !== 'button' && el.tagName.toLowerCase() !== 'input') {
            const btn = el.closest('button, [role="button"], input, a') || el.querySelector('button, [role="button"], input');
            if (btn) target = btn;
        }

        if (isCollectButton(target) && !validButtons.includes(target)) {
            validButtons.push(target);
        }
    }

    return validButtons;
}

/**
 * Check if a button has already been clicked, collected, or claimed
 */
function isCollectedOrClicked(button, collectedCouponIds) {
    if (!button) return true;
    if (button.dataset.arcCollected === 'true') return true;

    const parentBtn = button.closest('.a-button');
    if (parentBtn && parentBtn.dataset.arcCollected === 'true') return true;

    const couponId = getCouponId(button);
    if (couponId && collectedCouponIds.has(couponId)) return true;

    return !isCollectButton(button);
}

/**
 * Scroll horizontally and vertically to center the target coupon in view
 */
async function scrollToCoupon(button) {
    if (!button) return;

    // Center button smoothly in viewport
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

    // Align any horizontal scrollable container (e.g. mobile carousels)
    let parent = button.parentElement;
    while (parent && parent !== document.body) {
        if (parent.scrollWidth > parent.clientWidth + 10) {
            const btnRect = button.getBoundingClientRect();
            const parentRect = parent.getBoundingClientRect();
            if (btnRect.left < parentRect.left + 15 || btnRect.right > parentRect.right - 15) {
                const targetScrollLeft = parent.scrollLeft + (btnRect.left - parentRect.left) - (parentRect.width / 2) + (btnRect.width / 2);
                parent.scrollTo({
                    left: Math.max(0, targetScrollLeft),
                    behavior: 'smooth'
                });
            }
            break;
        }
        parent = parent.parentElement || (parent.getRootNode && parent.getRootNode() !== document ? parent.getRootNode().host : null);
    }

    await sleep(getRandomDelay(150, 250));
}

/**
 * Simulate human mouse & touch click sequence on button
 */
async function simulateHumanClick(button, collectedCouponIds) {
    if (!button) return;

    // Mark collected immediately
    button.dataset.arcCollected = 'true';
    const parent = button.parentElement || (button.getRootNode && button.getRootNode() !== document ? button.getRootNode().host : null);
    if (parent && parent.dataset) parent.dataset.arcCollected = 'true';

    const couponId = getCouponId(button);
    if (couponId) {
        collectedCouponIds.add(couponId);
    }

    const rect = button.getBoundingClientRect();
    const clientX = Math.round(rect.left + (rect.width > 0 ? rect.width / 2 : 10));
    const clientY = Math.round(rect.top + (rect.height > 0 ? rect.height / 2 : 10));
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

    // Pointer events (Mobile / Touch listeners)
    try {
        button.dispatchEvent(new PointerEvent('pointerover', { ...baseEventInit, pointerType: 'touch' }));
        button.dispatchEvent(new PointerEvent('pointerenter', { ...baseEventInit, pointerType: 'touch' }));
        button.dispatchEvent(new PointerEvent('pointerdown', { ...baseEventInit, pointerType: 'touch', isPrimary: true, button: 0 }));
    } catch (e) {}

    // Mouse events (Desktop listeners)
    try {
        button.dispatchEvent(new MouseEvent('mouseover', { ...baseEventInit, buttons: 0 }));
        button.dispatchEvent(new MouseEvent('mouseenter', { ...baseEventInit, buttons: 0 }));
        button.dispatchEvent(new MouseEvent('mousedown', { ...baseEventInit, button: 0, buttons: 1 }));
    } catch (e) {}

    await sleep(getRandomDelay(40, 80));

    try {
        button.dispatchEvent(new PointerEvent('pointerup', { ...baseEventInit, pointerType: 'touch', isPrimary: true, button: 0 }));
    } catch (e) {}

    try {
        button.dispatchEvent(new MouseEvent('mouseup', { ...baseEventInit, button: 0, buttons: 0 }));
    } catch (e) {}

    // Native DOM click
    try {
        button.click();
    } catch (e) {
        try {
            button.dispatchEvent(new MouseEvent('click', { ...baseEventInit, button: 0, buttons: 0 }));
        } catch (err) {}
    }
}

/**
 * Expand fragment "Load more" buttons if present
 */
function expandLoadMoreButtons() {
    const moreButtons = querySelectorAllDeep(
        '.fragment-load-more-button, .fragment-load-more-button input, .fragment-load-more-button .a-button-text, button[data-action="load-more"], a[data-action="load-more"]'
    );
    for (const btn of moreButtons) {
        if (btn && btn.dataset.arcExpanded !== 'true') {
            btn.dataset.arcExpanded = 'true';
            try { btn.click(); } catch (e) {}
        }
    }
}

/**
 * Sweep horizontal carousels visible in the viewport to reveal and collect offscreen cards
 */
async function sweepCarouselsInView(collectedCouponIds, onCollect, isTimeUp) {
    const carousels = querySelectorAllDeep(
        'tux-slider, .carousel-scroller-card-list-container, .coupons-wrap, [role="list"].remove-scrollbars, .a-carousel, .a-carousel-viewport, .a-carousel-container, .carousel-mobile'
    );

    for (const c of carousels) {
        if (abortRequested || (isTimeUp && isTimeUp())) break;

        const rect = c.getBoundingClientRect();
        // Skip if outside vertical view
        if (rect.bottom < -200 || rect.top > window.innerHeight + 200) {
            continue;
        }

        // Advance standard Amazon AUI desktop carousel if next button exists
        const carouselContainer = c.closest('.a-carousel-container') || c;
        const nextBtn = carouselContainer.querySelector?.('.a-carousel-goto-nextpage, .a-carousel-right');

        if (c.scrollWidth <= c.clientWidth + 15 && !nextBtn) {
            continue;
        }

        const maxScrollLeft = Math.max(0, c.scrollWidth - c.clientWidth);
        const step = Math.max(250, Math.floor((c.clientWidth || 350) * 0.75));

        // Scroll native overflow carousels
        if (maxScrollLeft > 0) {
            for (let left = 0; left <= maxScrollLeft + step; left += step) {
                if (abortRequested || (isTimeUp && isTimeUp())) break;

                c.scrollTo({ left: Math.min(left, maxScrollLeft), behavior: 'smooth' });
                await sleep(getRandomDelay(120, 200));

                const carouselButtons = findCollectButtons(c);
                const uncollected = carouselButtons.filter(btn => !isCollectedOrClicked(btn, collectedCouponIds));

                for (const btn of uncollected) {
                    if (abortRequested || (isTimeUp && isTimeUp())) break;
                    if (isCollectedOrClicked(btn, collectedCouponIds)) continue;

                    await scrollToCoupon(btn);
                    await simulateHumanClick(btn, collectedCouponIds);
                    onCollect();
                    await sleep(getRandomDelay(250, 450));
                }

                if (left >= maxScrollLeft) break;
            }
        }

        // Advance AUI paged carousels if next button is active
        if (nextBtn && !nextBtn.classList.contains('a-disabled')) {
            for (let p = 0; p < 4; p++) {
                if (abortRequested || (isTimeUp && isTimeUp())) break;
                if (nextBtn.classList.contains('a-disabled')) break;

                const carouselButtons = findCollectButtons(carouselContainer);
                const uncollected = carouselButtons.filter(btn => !isCollectedOrClicked(btn, collectedCouponIds));

                for (const btn of uncollected) {
                    if (abortRequested || (isTimeUp && isTimeUp())) break;
                    if (isCollectedOrClicked(btn, collectedCouponIds)) continue;

                    await scrollToCoupon(btn);
                    await simulateHumanClick(btn, collectedCouponIds);
                    onCollect();
                    await sleep(getRandomDelay(250, 450));
                }

                try { nextBtn.click(); } catch (e) {}
                await sleep(getRandomDelay(300, 450));
            }
        }
    }
}

/**
 * Main collection controller: progressive downward sweep with horizontal carousel processing
 */
async function collectAllCoupons() {
    if (isCollecting) {
        return;
    }

    isCollecting = true;
    abortRequested = false;
    console.log('Starting Amazon Rewards coupon collection with progressive sweep...');

    const startTime = Date.now();
    const MAX_DURATION_MS = 170000; // Under 180s background ceiling
    const isTimeUp = () => (Date.now() - startTime) >= MAX_DURATION_MS;

    const collectedCouponIds = new Set();
    let collectedCount = 0;

    const notifyProgress = (msg) => {
        chrome.runtime.sendMessage({
            action: 'collectionProgress',
            current: collectedCount,
            total: Math.max(collectedCount, collectedCount + 5),
            sessionCollected: collectedCount,
            message: msg || `Collected ${collectedCount} reward${collectedCount === 1 ? '' : 's'}...`
        }).catch(() => {});
    };

    notifyProgress('Scanning rewards page...');

    // 1. Start from the top
    window.scrollTo({ top: 0, behavior: 'instant' });
    await sleep(400);

    // 2. Progressive downward sweep
    const SCROLL_STEP = 400;
    let noNewContentChecks = 0;

    while (!abortRequested && !isTimeUp()) {
        // Expand any load-more fragment buttons
        expandLoadMoreButtons();

        // Check horizontal carousels in view
        await sweepCarouselsInView(collectedCouponIds, () => {
            collectedCount++;
            notifyProgress();
        }, isTimeUp);

        // Find and collect all buttons in view
        const currentButtons = findCollectButtons();
        const uncollected = currentButtons.filter(btn => !isCollectedOrClicked(btn, collectedCouponIds));

        for (const btn of uncollected) {
            if (abortRequested || isTimeUp()) break;
            if (isCollectedOrClicked(btn, collectedCouponIds)) continue;

            await scrollToCoupon(btn);
            if (abortRequested || isTimeUp()) break;

            await simulateHumanClick(btn, collectedCouponIds);
            collectedCount++;
            notifyProgress();

            await sleep(getRandomDelay(280, 500));
        }

        // Check if we've reached the bottom of the document
        const scrollBottom = window.scrollY + window.innerHeight;
        const docHeight = Math.max(document.body.scrollHeight || 0, document.documentElement.scrollHeight || 0);

        if (scrollBottom >= docHeight - 30) {
            // Wait to see if infinite scroll loads more content
            await sleep(700);
            const newDocHeight = Math.max(document.body.scrollHeight || 0, document.documentElement.scrollHeight || 0);
            if (newDocHeight > docHeight + 80) {
                window.scrollBy({ top: SCROLL_STEP, behavior: 'smooth' });
                await sleep(350);
                noNewContentChecks = 0;
                continue;
            } else {
                noNewContentChecks++;
                if (noNewContentChecks >= 2) {
                    break; // Truly at bottom
                }
            }
        }

        // Scroll down to reveal next section
        window.scrollBy({ top: SCROLL_STEP, behavior: 'smooth' });
        await sleep(getRandomDelay(220, 380));
    }

    // 3. One quick upward verification pass to collect any late-rendered items
    if (!abortRequested && !isTimeUp()) {
        const remainingButtons = findCollectButtons().filter(btn => !isCollectedOrClicked(btn, collectedCouponIds));
        if (remainingButtons.length > 0) {
            console.log(`Verification pass: Collecting ${remainingButtons.length} additional coupons...`);
            for (const btn of remainingButtons) {
                if (abortRequested || isTimeUp()) break;
                if (isCollectedOrClicked(btn, collectedCouponIds)) continue;

                await scrollToCoupon(btn);
                await simulateHumanClick(btn, collectedCouponIds);
                collectedCount++;
                notifyProgress();
                await sleep(getRandomDelay(280, 480));
            }
        }
    }

    isCollecting = false;
    const finishedMessage = abortRequested
        ? 'Collection stopped.'
        : `All available coupons collected (${collectedCount} total).`;

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
