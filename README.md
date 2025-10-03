# Amazon Rewards Coupon Collector Chrome Extension

This Chrome extension automatically collects all available coupons on the Amazon Rewards page (https://www.amazon.in/h/rewards).

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the folder containing these files
5. The extension should now be installed

## Usage

1. Navigate to https://www.amazon.in/h/rewards
2. Click the extension icon in the Chrome toolbar
3. Click "Collect All Coupons"
4. The extension will automatically click all "Collect Now" buttons with a 2-second delay between each click
5. Check the browser console for progress updates

## Files

- `manifest.json` - Extension manifest
- `content.js` - Content script that runs on the rewards page
- `popup.html` - Extension popup interface
- `popup.js` - Popup script for triggering collection

## Safety Note

This extension simulates user clicks. Use at your own risk and ensure you comply with Amazon's terms of service.