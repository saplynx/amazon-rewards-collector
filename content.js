// Content script for Amazon Rewards Coupon Collector

function collectAllCoupons() {
    // Find all buttons that contain "Collect Now" text
    const allButtons = document.querySelectorAll('button');
    const collectButtons = Array.from(allButtons).filter(button =>
        button.textContent.trim().toLowerCase() === 'collect now'
    );

    console.log(`Found ${collectButtons.length} collect buttons`);

    if (collectButtons.length === 0) {
        alert('No "Collect Now" buttons found on this page.');
        return;
    }

    let index = 0;

    function clickNext() {
        if (index < collectButtons.length) {
            const button = collectButtons[index];
            console.log(`Clicking button ${index + 1}/${collectButtons.length}: ${button.id}`);

            // Click the button
            button.click();

            index++;

            // Wait 2 seconds before next click to avoid rate limiting
            setTimeout(clickNext, 2000);
        } else {
            console.log('All buttons clicked!');
            alert('All available coupons have been collected!');
        }
    }

    // Start clicking
    clickNext();
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'collectCoupons') {
        collectAllCoupons();
        sendResponse({status: 'started'});
    }
});