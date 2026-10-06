// Script for summary.html

document.addEventListener('DOMContentLoaded', async () => {
    // Header elements
    const headerBadge = document.getElementById('headerBadge');
    const badgeText = document.getElementById('badgeText');

    // Live progress elements
    const liveProgressContainer = document.getElementById('liveProgressContainer');
    const liveStatusText = document.getElementById('liveStatusText');
    const liveProgressFraction = document.getElementById('liveProgressFraction');
    const liveProgressBar = document.getElementById('liveProgressBar');

    // Banner elements
    const statusBanner = document.getElementById('statusBanner');
    const bannerTitle = document.getElementById('bannerTitle');
    const bannerSubtext = document.getElementById('bannerSubtext');
    const bannerIcon = document.getElementById('bannerIcon');

    // Stat cards
    const sessionCountEl = document.getElementById('sessionCount');
    const sessionSubtextEl = document.getElementById('sessionSubtext');
    const totalCountEl = document.getElementById('totalCount');
    const latestTimeEl = document.getElementById('latestTime');

    // Action buttons
    const collectAgainBtn = document.getElementById('collectAgainBtn');
    const collectAgainBtnText = document.getElementById('collectAgainBtnText');
    const stopCollectionBtn = document.getElementById('stopCollectionBtn');
    const openRewardsBtn = document.getElementById('openRewardsBtn');
    const resetStatsBtn = document.getElementById('resetStatsBtn');

    // History elements
    const historyTableBody = document.getElementById('historyTableBody');
    const emptyHistoryMsg = document.getElementById('emptyHistoryMsg');

    /**
     * Render full state based on storage data
     */
    async function renderSummary() {
        try {
            const data = await chrome.storage.local.get([
                'appState',
                'lastSessionCount',
                'totalCouponsCollected',
                'lastCollectionTime',
                'collectionHistory'
            ]);

            const appState = data.appState || { status: 'idle', phase: 'idle' };
            const isRunning = appState.status === 'running';

            const sessionCount = typeof appState.sessionCollected === 'number' 
                ? appState.sessionCollected 
                : (typeof data.lastSessionCount === 'number' ? data.lastSessionCount : 0);

            const totalCount = typeof data.totalCouponsCollected === 'number' 
                ? data.totalCouponsCollected 
                : 0;

            const latestTime = data.lastCollectionTime || (isRunning ? 'In progress...' : '--');
            const history = Array.isArray(data.collectionHistory) ? data.collectionHistory : [];

            // Update stats cards
            sessionCountEl.textContent = sessionCount;
            totalCountEl.textContent = isRunning ? totalCount + sessionCount : totalCount;
            latestTimeEl.textContent = latestTime;

            if (sessionCount === 0 && !isRunning) {
                sessionSubtextEl.textContent = 'All available coupons were already collected';
            } else if (isRunning) {
                sessionSubtextEl.textContent = 'Activating coupons in real-time...';
            } else {
                sessionSubtextEl.textContent = `${sessionCount} new coupon${sessionCount > 1 ? 's' : ''} activated`;
            }

            // Update action buttons
            collectAgainBtn.disabled = isRunning;
            collectAgainBtnText.textContent = isRunning ? 'Collecting...' : 'Collect Again';
            if (stopCollectionBtn) {
                stopCollectionBtn.style.display = isRunning ? 'inline-flex' : 'none';
            }

            // Live progress & status rendering
            if (isRunning) {
                // Show live progress card
                liveProgressContainer.style.display = 'block';
                liveStatusText.textContent = appState.message || 'Collecting available coupons...';

                if (appState.total > 0) {
                    const pct = Math.min(100, Math.round((appState.current / appState.total) * 100));
                    liveProgressBar.style.width = `${pct}%`;
                    liveProgressFraction.textContent = `${appState.current} / ${appState.total}`;
                } else {
                    liveProgressBar.style.width = '100%';
                    liveProgressFraction.textContent = '';
                }

                // Hide completed banner during execution
                statusBanner.style.display = 'none';

                // Header badge
                headerBadge.style.backgroundColor = 'rgba(245, 158, 11, 0.15)';
                headerBadge.style.color = '#f59e0b';
                badgeText.textContent = 'In Progress';

            } else if (appState.status === 'done') {
                liveProgressContainer.style.display = 'none';
                statusBanner.style.display = 'flex';
                statusBanner.style.background = 'linear-gradient(135deg, #055a47, #067d62)';
                bannerTitle.textContent = 'All available coupons collected';
                bannerSubtext.textContent = 'Your session finished and the rewards page was closed automatically.';
                bannerIcon.textContent = '🎉';

                headerBadge.style.backgroundColor = '';
                headerBadge.style.color = '';
                badgeText.textContent = 'Completed';

            } else if (appState.status === 'error') {
                liveProgressContainer.style.display = 'none';
                statusBanner.style.display = 'flex';
                statusBanner.style.background = 'linear-gradient(135deg, #7f1d1d, #b91c1c)';
                bannerTitle.textContent = appState.phase === 'login_required' 
                    ? 'Amazon Login Required' 
                    : 'Unable to complete collection';
                bannerSubtext.textContent = appState.message || 'Please verify your Amazon connection or login and try again.';
                bannerIcon.textContent = '⚠️';

                headerBadge.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
                headerBadge.style.color = '#ef4444';
                badgeText.textContent = 'Error';

            } else {
                liveProgressContainer.style.display = 'none';
                if (history.length > 0) {
                    statusBanner.style.display = 'flex';
                    bannerTitle.textContent = 'All available coupons collected';
                    bannerSubtext.textContent = 'Ready to collect more rewards whenever you want.';
                    bannerIcon.textContent = '✓';
                } else {
                    statusBanner.style.display = 'none';
                }

                headerBadge.style.backgroundColor = '';
                headerBadge.style.color = '';
                badgeText.textContent = 'Ready';
            }

            // Render history table
            historyTableBody.innerHTML = '';
            if (history.length === 0) {
                emptyHistoryMsg.style.display = 'block';
            } else {
                emptyHistoryMsg.style.display = 'none';
                history.forEach(item => {
                    const row = document.createElement('tr');

                    const dateCell = document.createElement('td');
                    dateCell.textContent = item.date || 'Recent';

                    const countCell = document.createElement('td');
                    const countSpan = document.createElement('span');
                    countSpan.style.fontWeight = '600';
                    countSpan.style.color = item.collectedInSession > 0 ? '#10b981' : 'var(--text-muted)';
                    countSpan.textContent = item.collectedInSession > 0 ? `+${item.collectedInSession}` : '0 (Already collected)';
                    countCell.appendChild(countSpan);

                    const totalCell = document.createElement('td');
                    totalCell.textContent = item.totalToDate ?? '--';

                    row.appendChild(dateCell);
                    row.appendChild(countCell);
                    row.appendChild(totalCell);
                    historyTableBody.appendChild(row);
                });
            }
        } catch (e) {
            console.error('Failed to render summary data:', e);
        }
    }

    // Initial render
    await renderSummary();

    // Listen for live storage updates from background worker
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local') {
            renderSummary();
        }
    });

    // Handle "Collect Again"
    collectAgainBtn.addEventListener('click', async () => {
        collectAgainBtn.disabled = true;
        collectAgainBtnText.textContent = 'Starting...';

        try {
            await chrome.runtime.sendMessage({ action: 'start' });
        } catch (err) {
            console.error('Failed to trigger collection:', err);
            collectAgainBtn.disabled = false;
            collectAgainBtnText.textContent = 'Collect Again';
        }
    });

    // Handle "Stop"
    if (stopCollectionBtn) {
        stopCollectionBtn.addEventListener('click', async () => {
            try {
                stopCollectionBtn.disabled = true;
                await chrome.runtime.sendMessage({ action: 'stop' });
            } catch (err) {
                console.error('Failed to stop collection:', err);
            } finally {
                stopCollectionBtn.disabled = false;
            }
        });
    }

    // Handle "Open Amazon Rewards"
    openRewardsBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://www.amazon.in/h/rewards' });
    });

    // Handle "Clear History"
    resetStatsBtn.addEventListener('click', async () => {
        try {
            await chrome.storage.local.set({
                lastSessionCount: 0,
                totalCouponsCollected: 0,
                lastCollectionTime: '--',
                collectionHistory: [],
                appState: {
                    status: 'idle',
                    phase: 'idle',
                    message: 'Click Start to collect all available rewards',
                    current: 0,
                    total: 0,
                    sessionCollected: 0
                }
            });
            await renderSummary();
        } catch (e) {
            console.error('Failed to clear stats:', e);
        }
    });
});
