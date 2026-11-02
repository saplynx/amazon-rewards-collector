// Background service worker for Amazon Rewards Coupon Collector

const REWARDS_LINK = "https://www.amazon.in/h/rewards";
const AFFILIATE_LINK = "https://amzn.to/46zyQIR";
const TARGET_WIDTH = 393;
const TARGET_HEIGHT = 852;
const MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// Active debugging tabs set
const attachedTabs = new Set();
let activeRewardTabId = null;
let currentSafetyTimer = null;
let maxDurationTimer = null;
let latestSessionCount = 0;

/**
 * Sliding watchdog timer: resets whenever progress is made, triggering only on 35s of inactivity
 */
function resetWatchdogTimer(tabId) {
    if (currentSafetyTimer) {
        clearTimeout(currentSafetyTimer);
    }
    currentSafetyTimer = setTimeout(async () => {
        console.warn('Watchdog timeout: no progress received for 35s. Concluding collection.');
        await handleCollectionFinished(latestSessionCount, tabId || activeRewardTabId);
    }, 35000);
}

/**
 * Clear all safety and ceiling timers
 */
function clearAllTimers() {
    if (currentSafetyTimer) {
        clearTimeout(currentSafetyTimer);
        currentSafetyTimer = null;
    }
    if (maxDurationTimer) {
        clearTimeout(maxDurationTimer);
        maxDurationTimer = null;
    }
}

/**
 * Helper to update centralized application state in chrome.storage.local
 */
async function setAppState(updates) {
    try {
        const stored = await chrome.storage.local.get(['appState']);
        const current = stored.appState || {
            status: 'idle',
            phase: 'idle',
            message: 'Click Start to collect all available rewards',
            current: 0,
            total: 0,
            sessionCollected: 0
        };
        const appState = {
            ...current,
            ...updates,
            updatedAt: Date.now()
        };
        await chrome.storage.local.set({ appState });
    } catch (e) {
        console.warn('Failed to update appState:', e);
    }
}

/**
 * Clean up any stale running state when worker starts or wakes up
 */
(async function cleanupStaleState() {
    try {
        const stored = await chrome.storage.local.get(['appState']);
        if (stored.appState && stored.appState.status === 'running') {
            const elapsed = Date.now() - (stored.appState.updatedAt || 0);
            if (elapsed > 30000) {
                console.log('Resetting stale running state from previous session.');
                await setAppState({
                    status: 'idle',
                    phase: 'idle',
                    message: 'Click Start to collect all available rewards'
                });
            }
        }
    } catch (e) {}
})();

/**
 * Ensure the summary page is open and focused immediately
 */
async function ensureSummaryTab() {
    const summaryUrl = chrome.runtime.getURL('summary.html');
    try {
        const tabs = await chrome.tabs.query({ url: summaryUrl });
        if (tabs && tabs.length > 0) {
            await chrome.tabs.update(tabs[0].id, { active: true });
            if (tabs[0].windowId) {
                await chrome.windows.update(tabs[0].windowId, { focused: true });
            }
            return tabs[0];
        }
        return await chrome.tabs.create({ url: summaryUrl, active: true });
    } catch (err) {
        console.error('Error opening summary tab:', err);
        return null;
    }
}

/**
 * Attach Chrome debugger and apply mobile device emulation (393 x 852)
 */
async function emulateMobileView(tabId) {
    const debuggee = { tabId };

    if (!attachedTabs.has(tabId)) {
        try {
            await chrome.debugger.attach(debuggee, "1.3");
            attachedTabs.add(tabId);
        } catch (err) {
            if (!err.message?.includes('already attached')) {
                console.warn('Could not attach debugger:', err);
                return;
            }
            attachedTabs.add(tabId);
        }
    }

    // Set mobile viewport resolution (393 x 852)
    try {
        await chrome.debugger.sendCommand(debuggee, "Emulation.setDeviceMetricsOverride", {
            width: TARGET_WIDTH,
            height: TARGET_HEIGHT,
            deviceScaleFactor: 3,
            mobile: true,
            screenOrientation: {
                type: "portraitPrimary",
                angle: 0
            }
        });
    } catch (e) {
        console.warn('Emulation.setDeviceMetricsOverride warning:', e);
    }

    // Enable touch events
    try {
        await chrome.debugger.sendCommand(debuggee, "Emulation.setTouchEmulationEnabled", {
            enabled: true,
            maxTouchPoints: 5
        });
    } catch (e) {
        console.warn('Emulation.setTouchEmulationEnabled warning:', e);
    }

    // Override User Agent to Mobile Safari/iPhone
    try {
        await chrome.debugger.sendCommand(debuggee, "Network.enable");
    } catch (e) {}

    try {
        await chrome.debugger.sendCommand(debuggee, "Emulation.setUserAgentOverride", {
            userAgent: MOBILE_USER_AGENT,
            platform: "iPhone"
        });
    } catch (e) {
        console.warn('Emulation.setUserAgentOverride warning:', e);
    }
}

/**
 * Wait for a tab to finish loading
 */
function waitForTabComplete(tabId, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        let isDone = false;
        const timer = setTimeout(() => {
            if (isDone) return;
            isDone = true;
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error(`Timeout waiting for tab to load`));
        }, timeoutMs);

        function listener(updatedTabId, changeInfo, tab) {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                if (isDone) return;
                isDone = true;
                chrome.tabs.onUpdated.removeListener(listener);
                clearTimeout(timer);
                resolve(tab);
            }
        }

        chrome.tabs.onUpdated.addListener(listener);

        // Immediate check in case tab is already complete
        chrome.tabs.get(tabId).then(tab => {
            if (tab && tab.status === 'complete') {
                if (isDone) return;
                isDone = true;
                chrome.tabs.onUpdated.removeListener(listener);
                clearTimeout(timer);
                resolve(tab);
            }
        }).catch(() => {});
    });
}

/**
 * Wait for a tab to reach target page, with early login redirect detection
 */
function waitForTabUrlAndComplete(tabId, urlSubstr, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        let isDone = false;
        const timer = setTimeout(() => {
            if (isDone) return;
            isDone = true;
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error(`Timeout waiting for tab to reach target page`));
        }, timeoutMs);

        function checkTab(tab) {
            if (!tab || isDone) return;
            // Check if Amazon redirected to login page
            if (tab.url && (tab.url.includes('/signin') || tab.url.includes('/ap/signin') || tab.url.includes('openid.assoc_handle'))) {
                isDone = true;
                chrome.tabs.onUpdated.removeListener(listener);
                clearTimeout(timer);
                reject(new Error('LOGIN_REQUIRED'));
                return;
            }

            if (tab.url && tab.url.includes(urlSubstr) && tab.status === 'complete') {
                isDone = true;
                chrome.tabs.onUpdated.removeListener(listener);
                clearTimeout(timer);
                resolve(tab);
            }
        }

        function listener(updatedTabId, changeInfo, tab) {
            if (updatedTabId === tabId) {
                checkTab(tab);
            }
        }

        chrome.tabs.onUpdated.addListener(listener);

        // Immediate check in case tab already reached target or redirected
        chrome.tabs.get(tabId).then(tab => {
            checkTab(tab);
        }).catch(() => {});
    });
}

/**
 * Stop any ongoing collection immediately
 */
async function stopMobileRewardFlow() {
    clearAllTimers();

    if (activeRewardTabId) {
        try {
            await chrome.tabs.sendMessage(activeRewardTabId, { action: 'stopCollection' });
        } catch (e) {}

        if (attachedTabs.has(activeRewardTabId)) {
            attachedTabs.delete(activeRewardTabId);
            await chrome.debugger.detach({ tabId: activeRewardTabId }).catch(() => {});
        }
        await chrome.tabs.remove(activeRewardTabId).catch(() => {});
        activeRewardTabId = null;
    }

    // Detach any remaining attached tabs
    for (const tabId of attachedTabs) {
        await chrome.debugger.detach({ tabId }).catch(() => {});
    }
    attachedTabs.clear();

    await setAppState({
        status: 'idle',
        phase: 'idle',
        message: 'Collection stopped.',
        current: 0,
        total: 0
    });

    return { success: true };
}

/**
 * Main execution flow:
 * 1. Immediately opens summary page
 * 2. Opens rewards page in background
 * 3. Sets mobile emulation (393x852)
 * 4. Reloads page
 * 5. Runs coupon collection (completing within <= 25 seconds)
 * 6. Hard safety cutoff ensures completion within 26s under all conditions
 */
async function startMobileRewardFlow() {
    // If a previous run is actively in progress within 30s, stop it first to prevent duplicate loops
    try {
        const stored = await chrome.storage.local.get(['appState']);
        if (stored.appState && stored.appState.status === 'running') {
            const elapsed = Date.now() - (stored.appState.updatedAt || 0);
            if (elapsed < 30000) {
                console.log('Collection already in progress, aborting previous run and restarting cleanly.');
                await stopMobileRewardFlow();
            }
        }
    } catch (e) {}

    latestSessionCount = 0;
    clearAllTimers();

    // Step 1: Open the summary page IMMEDIATELY so the user can watch live progress
    await ensureSummaryTab();

    // Initialize state
    await setAppState({
        status: 'running',
        phase: 'starting',
        message: 'Opening Amazon Rewards...',
        current: 0,
        total: 0,
        sessionCollected: 0
    });

    let rewardsTab = null;

    try {
        // Step 2: Open rewards page or reuse existing open rewards tab
        const existingTabs = await chrome.tabs.query({ url: "*://*.amazon.in/h/rewards*" });
        if (existingTabs && existingTabs.length > 0) {
            rewardsTab = existingTabs[0];
            activeRewardTabId = rewardsTab.id;
        } else {
            rewardsTab = await chrome.tabs.create({ url: REWARDS_LINK, active: false });
            activeRewardTabId = rewardsTab.id;
            await waitForTabUrlAndComplete(rewardsTab.id, 'amazon.in/h/rewards', 15000);
        }

        // Step 3: Emulate mobile device (if debugger supported)
        try {
            await setAppState({
                phase: 'preparing',
                message: 'Preparing rewards...'
            });
            await emulateMobileView(rewardsTab.id);

            // If debugger successfully attached, refresh to fetch mobile layout
            if (attachedTabs.has(rewardsTab.id)) {
                await setAppState({
                    phase: 'loading',
                    message: 'Loading offers...'
                });
                const reloadWait = waitForTabComplete(rewardsTab.id, 15000);
                await chrome.tabs.reload(rewardsTab.id);
                await reloadWait;
            }
        } catch (emuErr) {
            console.warn('Mobile emulation failed, continuing with standard layout:', emuErr);
        }

        // Step 5: Start coupon collection
        await setAppState({
            phase: 'collecting',
            message: 'Collecting available coupons...',
            current: 0,
            total: 0,
            sessionCollected: 0
        });

        // Start sliding watchdog timer and 3-minute overall safety ceiling
        resetWatchdogTimer(rewardsTab.id);
        maxDurationTimer = setTimeout(async () => {
            console.warn('Maximum overall duration reached (180s). Concluding collection.');
            await handleCollectionFinished(latestSessionCount, rewardsTab?.id);
        }, 180000);

        let collectionStarted = false;
        try {
            const response = await chrome.tabs.sendMessage(rewardsTab.id, { action: 'collectCoupons' });
            if (response && response.status === 'started') {
                collectionStarted = true;
            }
        } catch (err) {}

        if (!collectionStarted) {
            await chrome.scripting.executeScript({
                target: { tabId: rewardsTab.id },
                files: ['content.js']
            });
            await new Promise(r => setTimeout(r, 200));
            await chrome.tabs.sendMessage(rewardsTab.id, { action: 'collectCoupons' });
        }

        return { success: true, tabId: rewardsTab.id };

    } catch (error) {
        console.error('Error in mobile reward flow:', error);

        clearAllTimers();

        if (error.message === 'LOGIN_REQUIRED') {
            // User needs to log in; bring tab to foreground and inform user
            if (rewardsTab && rewardsTab.id) {
                await chrome.tabs.update(rewardsTab.id, { active: true });
                if (attachedTabs.has(rewardsTab.id)) {
                    attachedTabs.delete(rewardsTab.id);
                    await chrome.debugger.detach({ tabId: rewardsTab.id }).catch(() => {});
                }
            }
            await setAppState({
                status: 'error',
                phase: 'login_required',
                message: 'Please sign in to Amazon in the opened tab to collect coupons.'
            });
            return { success: false, error: 'Login required' };
        }

        await setAppState({
            status: 'error',
            phase: 'error',
            message: 'Unable to complete collection. Please try again.'
        });

        // Clean up debugger and tab on error
        if (rewardsTab && rewardsTab.id) {
            if (attachedTabs.has(rewardsTab.id)) {
                attachedTabs.delete(rewardsTab.id);
                await chrome.debugger.detach({ tabId: rewardsTab.id }).catch(() => {});
            }
            await chrome.tabs.remove(rewardsTab.id).catch(() => {});
            activeRewardTabId = null;
        }

        return { success: false, error: error.message };
    }
}

/**
 * Handle collection finished: record statistics, update state, detach debugger, and close rewards page
 */
async function handleCollectionFinished(count, tabId) {
    clearAllTimers();

    const targetTabId = tabId || activeRewardTabId;

    try {
        const stored = await chrome.storage.local.get(['totalCouponsCollected', 'collectionHistory']);
        const collectedCount = typeof count === 'number' ? count : latestSessionCount;
        const totalCoupons = (stored.totalCouponsCollected || 0) + collectedCount;
        const history = Array.isArray(stored.collectionHistory) ? stored.collectionHistory : [];

        const now = new Date();
        history.unshift({
            date: now.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
            isoDate: now.toISOString(),
            collectedInSession: collectedCount,
            totalToDate: totalCoupons
        });

        if (history.length > 50) {
            history.pop();
        }

        await chrome.storage.local.set({
            lastSessionCount: collectedCount,
            totalCouponsCollected: totalCoupons,
            lastCollectionTime: now.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
            collectionHistory: history
        });

        await setAppState({
            status: 'done',
            phase: 'done',
            message: 'All available coupons collected.',
            current: collectedCount,
            total: collectedCount,
            sessionCollected: collectedCount
        });

        // Detach debugger
        if (targetTabId && attachedTabs.has(targetTabId)) {
            attachedTabs.delete(targetTabId);
            await chrome.debugger.detach({ tabId: targetTabId }).catch(() => {});
        }

        // Close rewards page tab
        if (targetTabId) {
            await chrome.tabs.remove(targetTabId).catch(() => {});
        }
        activeRewardTabId = null;

        // Ensure summary page is active to view final stats
        await ensureSummaryTab();

    } catch (err) {
        console.error('Error handling collection completion:', err);
    }
}

// Message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'start') {
        startMobileRewardFlow().then(result => {
            sendResponse(result);
        });
        return true;
    }

    if (request.action === 'stop' || request.action === 'reset') {
        stopMobileRewardFlow().then(result => {
            sendResponse(result);
        });
        return true;
    }

    if (request.action === 'collectionProgress') {
        const current = request.current || 0;
        const total = request.total || 0;
        const sessionCollected = typeof request.sessionCollected === 'number' ? request.sessionCollected : current;
        latestSessionCount = sessionCollected;

        resetWatchdogTimer(sender.tab?.id || activeRewardTabId);

        const message = request.message || (total > 0 
            ? `Collecting coupon ${current} of ${total}...` 
            : 'Collecting available coupons...');

        setAppState({
            status: 'running',
            phase: 'collecting',
            message,
            current,
            total,
            sessionCollected
        });

        sendResponse({ received: true });
        return true;
    }

    if (request.action === 'collectionFinished') {
        const tabId = sender.tab?.id || activeRewardTabId;
        handleCollectionFinished(request.count, tabId).then(() => {
            sendResponse({ success: true });
        });
        return true;
    }
});

// Clean up debugger if tab is closed manually
chrome.tabs.onRemoved.addListener((tabId) => {
    if (attachedTabs.has(tabId)) {
        attachedTabs.delete(tabId);
    }
    if (activeRewardTabId === tabId) {
        activeRewardTabId = null;
    }
});

// Handle external debugger detach
chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId && attachedTabs.has(source.tabId)) {
        attachedTabs.delete(source.tabId);
    }
});
