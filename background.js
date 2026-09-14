// Background service worker for Amazon Rewards Coupon Collector

const REWARDS_LINK = "https://amzn.to/46zyQIR";
const TARGET_WIDTH = 393;
const TARGET_HEIGHT = 852;
const MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// Active debugging tabs set
const attachedTabs = new Set();
let activeRewardTabId = null;

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
                throw err;
            }
            attachedTabs.add(tabId);
        }
    }

    // Set mobile viewport resolution (393 x 852)
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

    // Enable touch events
    await chrome.debugger.sendCommand(debuggee, "Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 5
    });

    // Override User Agent to Mobile Safari/iPhone
    try {
        await chrome.debugger.sendCommand(debuggee, "Network.enable");
    } catch (e) {
        // Network might already be enabled
    }

    await chrome.debugger.sendCommand(debuggee, "Emulation.setUserAgentOverride", {
        userAgent: MOBILE_USER_AGENT,
        platform: "iPhone"
    });

    await chrome.debugger.sendCommand(debuggee, "Network.setUserAgentOverride", {
        userAgent: MOBILE_USER_AGENT,
        platform: "iPhone"
    });
}

/**
 * Wait for a tab to finish loading
 */
function waitForTabComplete(tabId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error(`Timeout waiting for tab to load`));
        }, timeoutMs);

        function listener(updatedTabId, changeInfo, tab) {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                clearTimeout(timer);
                resolve(tab);
            }
        }

        chrome.tabs.onUpdated.addListener(listener);
    });
}

/**
 * Wait for a tab to reach a target URL and complete loading
 */
function waitForTabUrlAndComplete(tabId, urlSubstr, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error(`Timeout waiting for tab to reach target page`));
        }, timeoutMs);

        function listener(updatedTabId, changeInfo, tab) {
            if (updatedTabId === tabId) {
                if (tab.url && tab.url.includes(urlSubstr) && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    clearTimeout(timer);
                    resolve(tab);
                }
            }
        }

        chrome.tabs.onUpdated.addListener(listener);
    });
}

/**
 * Main execution flow:
 * 1. Immediately opens summary page
 * 2. Opens rewards page in background
 * 3. Sets mobile emulation (393x852)
 * 4. Reloads page
 * 5. Runs coupon collection
 * 6. Closes rewards page when done
 */
async function startMobileRewardFlow() {
    // Prevent duplicate concurrent executions
    try {
        const stored = await chrome.storage.local.get(['appState']);
        if (stored.appState && stored.appState.status === 'running') {
            const elapsed = Date.now() - (stored.appState.updatedAt || 0);
            if (elapsed < 60000) {
                console.log('Collection already in progress, refocusing summary page.');
                await ensureSummaryTab();
                return { success: true, message: 'Already running' };
            }
        }
    } catch (e) {
        console.warn('Error reading appState:', e);
    }

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
        // Step 2: Open rewards page
        rewardsTab = await chrome.tabs.create({ url: REWARDS_LINK, active: false });
        activeRewardTabId = rewardsTab.id;

        await waitForTabUrlAndComplete(rewardsTab.id, 'amazon.in/h/rewards', 30000);

        // Step 3: Emulate mobile device
        await setAppState({
            phase: 'preparing',
            message: 'Preparing rewards...'
        });
        await emulateMobileView(rewardsTab.id);

        // Step 4: Refresh page in mobile mode
        await setAppState({
            phase: 'loading',
            message: 'Loading offers...'
        });
        const reloadWait = waitForTabComplete(rewardsTab.id, 30000);
        await chrome.tabs.reload(rewardsTab.id);
        await reloadWait;

        // Step 5: Start coupon collection
        await setAppState({
            phase: 'collecting',
            message: 'Collecting available coupons...',
            current: 0,
            total: 0,
            sessionCollected: 0
        });
        await new Promise(r => setTimeout(r, 2000));

        let collectionStarted = false;
        try {
            const response = await chrome.tabs.sendMessage(rewardsTab.id, { action: 'collectCoupons' });
            if (response && response.status === 'started') {
                collectionStarted = true;
            }
        } catch (err) {
            // Script may not be ready, fallback to executeScript
        }

        if (!collectionStarted) {
            await chrome.scripting.executeScript({
                target: { tabId: rewardsTab.id },
                files: ['content.js']
            });
            await new Promise(r => setTimeout(r, 500));
            await chrome.tabs.sendMessage(rewardsTab.id, { action: 'collectCoupons' });
        }

        return { success: true, tabId: rewardsTab.id };

    } catch (error) {
        console.error('Error in mobile reward flow:', error);
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
    const targetTabId = tabId || activeRewardTabId;

    try {
        const stored = await chrome.storage.local.get(['totalCouponsCollected', 'collectionHistory']);
        const collectedCount = typeof count === 'number' ? count : 0;
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

    if (request.action === 'collectionProgress') {
        const current = request.current || 0;
        const total = request.total || 0;
        const sessionCollected = typeof request.sessionCollected === 'number' ? request.sessionCollected : current;
        const message = total > 0 
            ? `Collecting coupon ${current} of ${total}...` 
            : 'Collecting available coupons...';

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
