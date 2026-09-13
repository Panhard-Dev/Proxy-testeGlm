/*
 * File: login.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { initPlaywright, closePlaywright, activePage } from './services/playwright.ts';

async function main() {
  console.log('Opening DeepSeek to allow login...');
  await initPlaywright(false); // false = not headless
  if (activePage) {
    await activePage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
  } else {
    console.error('Failed to get active page');
    process.exit(1);
  }
  console.log('Browser opened. Please login to chat.deepseek.com.');
  console.log('Once you are fully logged in and can see the chat interface, close the browser window or press Ctrl+C here.');
  
  // Wait indefinitely until user closes the process
  process.on('SIGINT', async () => {
    console.log('Closing browser...');
    await closePlaywright();
    process.exit(0);
  });
}

main();