import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const windowsChrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
export default defineConfig({
  testDir:'./test/browser',
  workers:1,
  timeout:30000,
  fullyParallel:false,
  reporter:'list',
  use:{baseURL:'http://127.0.0.1:3100',headless:true,launchOptions:{...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:existsSync(windowsChrome)?{executablePath:windowsChrome}:{})},screenshot:'only-on-failure',trace:'retain-on-failure'},
  webServer:{command:'node scripts/browser-server.js',url:'http://127.0.0.1:3100',reuseExistingServer:false,timeout:15000},
});
