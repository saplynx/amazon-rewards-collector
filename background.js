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
 * Sliding watchdog timer: resets whenever progress is made, triggering only on 45s of inactivity
 */
function resetWatchdogTimer(tabId) {
    if (currentSafetyTimer) {
        clearTimeout(currentSafetyTimer);
    }
    currentSafetyTimer = setTimeout(async () => {
        console.warn('Watchdog timeout: no progress received for 45s. Concluding collection.');
        await handleCollectionFinished(latestSessionCount, tabId || activeRewardTabId);
    }, 45000);
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
 * Ensure the summary page is open (by default in background so user watches Amazon tab)
 */
async function ensureSummaryTab(focus = false) {
    const summaryUrl = chrome.runtime.getURL('summary.html');
    try {
        const tabs = await chrome.tabs.query({ url: summaryUrl });
        if (tabs && tabs.length > 0) {
            if (focus) {
                await chrome.tabs.update(tabs[0].id, { active: true });
                if (tabs[0].windowId) {
                    await chrome.windows.update(tabs[0].windowId, { focused: true });
                }
            }
            return tabs[0];
        }
        return await chrome.tabs.create({ url: summaryUrl, active: focus });
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
 * Robust reload that waits for status to transition to loading and then complete
 */
function reloadTabAndWait(tabId, timeoutMs = 20000) {
    return new Promise((resolve) => {
        let hasStartedLoading = false;
        let isDone = false;

        const timer = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }, timeoutMs);

        function listener(updatedTabId, changeInfo) {
            if (updatedTabId === tabId) {
                if (changeInfo.status === 'loading') {
                    hasStartedLoading = true;
                }
                if (hasStartedLoading && changeInfo.status === 'complete') {
                    if (!isDone) {
                        isDone = true;
                        chrome.tabs.onUpdated.removeListener(listener);
                        clearTimeout(timer);
                        resolve();
                    }
                }
            }
        }

        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.reload(tabId).catch(() => {
            if (!isDone) {
                isDone = true;
                chrome.tabs.onUpdated.removeListener(listener);
                clearTimeout(timer);
                resolve();
            }
        });
    });
}

/**
 * Wait for a tab to finish loading
 */
function waitForTabComplete(tabId, timeoutMs = 15000) {
    return new Promise((resolve) => {
        let isDone = false;
        const timer = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }, timeoutMs);

        function listener(updatedTabId, changeInfo, tab) {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                if (!isDone) {
                    isDone = true;
                    chrome.tabs.onUpdated.removeListener(listener);
                    clearTimeout(timer);
                    resolve(tab);
                }
            }
        }

        chrome.tabs.onUpdated.addListener(listener);

        chrome.tabs.get(tabId).then(tab => {
            if (tab && tab.status === 'complete') {
                if (!isDone) {
                    isDone = true;
                    chrome.tabs.onUpdated.removeListener(listener);
                    clearTimeout(timer);
                    resolve(tab);
                }
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
            resolve(); // fallback: resolve to let flow continue
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

        chrome.tabs.get(tabId).then(tab => {
            checkTab(tab);
        }).catch(() => {});
    });
}

/**
 * Stop any ongoing collection immediately without closing user tabs
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
        // Do NOT close tab: let user continue viewing their page
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
 * 1. Brings/opens rewards page as active tab so user sees all manual scrolling and gestures
 * 2. Opens summary page in background for live state recording
 * 3. Applies mobile device emulation (if debugger available)
 * 4. Runs coupon collection with full visibility
 * 5. Detaches debugger cleanly without closing user tab
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

    // Step 1: Open summary page in background tab so progress is persisted
    await ensureSummaryTab(false);

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
            // Focus rewards tab so user can watch manual actions live
            await chrome.tabs.update(rewardsTab.id, { active: true }).catch(() => {});
            if (rewardsTab.status !== 'complete') {
                await waitForTabComplete(rewardsTab.id, 10000);
            }
        } else {
            // Create active rewards tab so user sees the actions immediately
            rewardsTab = await chrome.tabs.create({ url: REWARDS_LINK, active: true });
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
                await reloadTabAndWait(rewardsTab.id, 20000);
                await new Promise(r => setTimeout(r, 800));
            }
        } catch (emuErr) {
            console.warn('Mobile emulation failed, continuing with standard layout:', emuErr);
        }

        // Ensure rewards tab is focused and active for user to watch
        if (rewardsTab && rewardsTab.id) {
            await chrome.tabs.update(rewardsTab.id, { active: true }).catch(() => {});
        }

        // Step 4: Start coupon collection
        await setAppState({
            phase: 'collecting',
            message: 'Waiting for rewards page to finish loading...',
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

        // Robust message trigger with fallback script injection
        let collectionStarted = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const response = await chrome.tabs.sendMessage(rewardsTab.id, { action: 'collectCoupons' });
                if (response && response.status === 'started') {
                    collectionStarted = true;
                    break;
                }
            } catch (err) {}

            try {
                await chrome.scripting.executeScript({
                    target: { tabId: rewardsTab.id },
                    files: ['content.js']
                });
            } catch (e) {}

            await new Promise(r => setTimeout(r, 400));
        }

        return { success: true, tabId: rewardsTab.id };

    } catch (error) {
        console.error('Error in reward flow:', error);

        clearAllTimers();

        if (error.message === 'LOGIN_REQUIRED') {
            if (rewardsTab && rewardsTab.id) {
                await chrome.tabs.update(rewardsTab.id, { active: true }).catch(() => {});
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

        // Clean up debugger on error - DO NOT CLOSE USER TAB!
        if (rewardsTab && rewardsTab.id) {
            if (attachedTabs.has(rewardsTab.id)) {
                attachedTabs.delete(rewardsTab.id);
                await chrome.debugger.detach({ tabId: rewardsTab.id }).catch(() => {});
            }
        }

        return { success: false, error: error.message };
    }
}

/**
 * Handle collection finished: record statistics, update state, detach debugger, and leave rewards page open
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
            message: `All available coupons collected (${collectedCount} total).`,
            current: collectedCount,
            total: collectedCount,
            sessionCollected: collectedCount
        });

        // Detach debugger cleanly so the banner disappears and user has full normal control
        if (targetTabId && attachedTabs.has(targetTabId)) {
            attachedTabs.delete(targetTabId);
            await chrome.debugger.detach({ tabId: targetTabId }).catch(() => {});
        }

        // Leave rewards tab open so user can see and use their collected coupons!
        activeRewardTabId = null;

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

// Clean up debugger if tab is closed manually by user
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
