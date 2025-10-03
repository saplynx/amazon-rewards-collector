// Popup script for Amazon Rewards Coupon Collector

document.addEventListener('DOMContentLoaded', function() {
    const collectBtn = document.getElementById('collectBtn');
    const statusDiv = document.getElementById('status');

    collectBtn.addEventListener('click', async () => {
        try {
            // Get current active tab
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            // Check if we're on the correct page
            if (!tab.url.includes('amazon.in/h/rewards')) {
                statusDiv.textContent = 'Please navigate to Amazon Rewards page first.';
                statusDiv.style.color = 'red';
                return;
            }

            // Send message to content script
            statusDiv.textContent = 'Starting coupon collection...';
            statusDiv.style.color = 'blue';

            const response = await chrome.tabs.sendMessage(tab.id, { action: 'collectCoupons' });

            if (response && response.status === 'started') {
                statusDiv.textContent = 'Collection started! Check console for progress.';
                statusDiv.style.color = 'green';
            }

        } catch (error) {
            console.error('Error:', error);
            statusDiv.textContent = 'Error: Could not start collection.';
            statusDiv.style.color = 'red';
        }
    });

    const openRewardsBtn = document.getElementById('openRewardsBtn');
    openRewardsBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: "https://amzn.to/46zyQIR" });
    });
});