// Popup script for Amazon Rewards Coupon Collector

document.addEventListener('DOMContentLoaded', async () => {
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const statusDiv = document.getElementById('status');
    const progressBox = document.getElementById('progressBox');
    const progressLabel = document.getElementById('progressLabel');
    const progressFraction = document.getElementById('progressFraction');
    const progressBar = document.getElementById('progressBar');
    const viewSummaryLink = document.getElementById('viewSummaryLink');

    /**
     * Render UI based on central appState
     */
    function renderState(appState) {
        if (!appState) return;

        const isRunning = appState.status === 'running';

        // Start & Stop button states
        startBtn.disabled = isRunning;
        startBtn.textContent = isRunning ? 'Collecting...' : 'Start';
        if (stopBtn) {
            stopBtn.style.display = isRunning ? 'block' : 'none';
        }

        // Status text
        statusDiv.textContent = appState.message || 'Click Start to collect all available rewards';

        if (appState.status === 'error') {
            statusDiv.style.color = '#ef4444';
        } else if (appState.status === 'done') {
            statusDiv.style.color = '#10b981';
        } else if (isRunning) {
            statusDiv.style.color = '#f59e0b';
        } else {
            statusDiv.style.color = '';
        }

        // Live progress bar
        if (isRunning && appState.phase === 'collecting' && appState.total > 0) {
            progressBox.style.display = 'block';
            const pct = Math.min(100, Math.round((appState.current / appState.total) * 100));
            progressBar.style.width = `${pct}%`;
            progressFraction.textContent = `${appState.current} / ${appState.total}`;
            progressLabel.textContent = `Collecting (${pct}%)...`;
        } else if (isRunning) {
            progressBox.style.display = 'block';
            progressBar.style.width = '100%';
            progressFraction.textContent = '';
            progressLabel.textContent = appState.message;
        } else {
            progressBox.style.display = 'none';
            progressBar.style.width = '0%';
        }
    }

    // Initial state load
    try {
        const stored = await chrome.storage.local.get(['appState']);
        renderState(stored.appState);
    } catch (e) {
        console.warn('Could not read appState:', e);
    }

    // Listen for live state changes
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes.appState) {
            renderState(changes.appState.newValue);
        }
    });

    // Start collection
    startBtn.addEventListener('click', async () => {
        try {
            startBtn.disabled = true;
            startBtn.textContent = 'Collecting...';
            if (stopBtn) stopBtn.style.display = 'block';
            statusDiv.textContent = 'Opening Amazon Rewards...';
            statusDiv.style.color = '#f59e0b';

            await chrome.runtime.sendMessage({ action: 'start' });
        } catch (error) {
            console.error('Error triggering start flow:', error);
            startBtn.disabled = false;
            startBtn.textContent = 'Start';
            if (stopBtn) stopBtn.style.display = 'none';
            statusDiv.textContent = 'Unable to complete collection. Please try again.';
            statusDiv.style.color = '#ef4444';
        }
    });

    // Stop collection
    if (stopBtn) {
        stopBtn.addEventListener('click', async () => {
            try {
                stopBtn.disabled = true;
                stopBtn.textContent = 'Stopping...';
                await chrome.runtime.sendMessage({ action: 'stop' });
            } catch (err) {
                console.error('Error stopping flow:', err);
            } finally {
                stopBtn.disabled = false;
                stopBtn.textContent = 'Stop';
            }
        });
    }

    // View summary link
    if (viewSummaryLink) {
        viewSummaryLink.addEventListener('click', (e) => {
            e.preventDefault();
            chrome.tabs.create({ url: chrome.runtime.getURL('summary.html') });
        });
    }
});