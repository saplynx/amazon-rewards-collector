# Amazon Rewards Coupon Collector Chrome Extension

Chrome extension that automatically collects all available coupons and rewards on the Amazon Rewards page (`amazon.in/h/rewards`) using mobile device emulation (393 x 852) to surface all mobile-exclusive cards and rewards.

## Features

- **Single Click ("Start")**: Opens the rewards page via link, configures mobile inspect view emulation (393 x 852 viewport + mobile User-Agent), refreshes to fetch the mobile UI with more reward cards, and automatically collects all available coupons.
- **Silent & Abstract Operation**: No disruptive browser popups or alerts. Abstracted status messages ("Collecting available coupons...", "All available coupons collected").
- **Automatic Summary Page**: Automatically closes the rewards page upon completion and redirects to a dedicated summary page showing session coupons, all-time totals, and collection history.

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the folder containing these files
5. The extension should now be installed

## Usage

1. Click the extension icon in the Chrome toolbar.
2. Click the **"Start"** button.
3. The extension will automatically:
   - Open and prepare the Amazon Rewards page in mobile layout
   - Sequentially collect all available coupons with safety delays
   - Close the rewards tab once collection is complete
   - Redirect to the **Summary Page** displaying collected counts and history

## Safety Note

This extension simulates user clicks with realistic intervals. Use at your own risk and ensure you comply with Amazon's terms of service.
