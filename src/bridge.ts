/**
 * Figma Selection Bridge — Standalone entry point for terminal testing.
 *
 *   npm run bridge
 *
 * This is only needed when you want to test WITHOUT launching the full
 * VS Code Extension Development Host (F5). In normal use the extension
 * calls startBridge() automatically on activation.
 *
 * Starts Express on 127.0.0.1:3050.
 */
import { startBridge } from './bridge/server';

console.log('[Figma Bridge] Starting standalone bridge on 127.0.0.1:3050…');

startBridge();

process.on('SIGINT',  () => { console.log('[Figma Bridge] Stopped'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[Figma Bridge] Stopped'); process.exit(0); });
