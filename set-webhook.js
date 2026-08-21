/**
 * set-webhook.js
 * Utility to check, set, or delete Telegram Bot Webhook.
 *
 * Usage:
 *   node set-webhook.js https://your-public-url.com
 *   node set-webhook.js --info
 *   node set-webhook.js --delete
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Try loading token from .env or .env.local if not already in process.env
function loadEnvToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  const envFiles = ['.env.local', '.env'];
  for (const file of envFiles) {
    const filePath = path.resolve(process.cwd(), file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const match = content.match(/TELEGRAM_BOT_TOKEN\s*=\s*["']?([^"'\r\n]+)["']?/);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  }
  return '8767722632:AAERn7tPHJOXgOXXiNRuT0Sf8GPsn4rwO90';
}

const BOT_TOKEN = loadEnvToken();
const arg = process.argv[2];

function makeTelegramRequest(endpoint) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`;
  https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        console.log(JSON.stringify(result, null, 2));
      } catch {
        console.log(data);
      }
    });
  }).on('error', (err) => {
    console.error('Request error:', err.message);
  });
}

if (!arg || arg === '--info' || arg === '-i') {
  console.log(`Checking current webhook status for bot...`);
  makeTelegramRequest('getWebhookInfo');
} else if (arg === '--delete' || arg === '-d') {
  console.log(`Deleting Telegram webhook...`);
  makeTelegramRequest('deleteWebhook?drop_pending_updates=true');
} else {
  const cleanUrl = arg.trim().replace(/\/$/, '');
  const webhookUrl = cleanUrl.endsWith('/api/telegram') ? cleanUrl : `${cleanUrl}/api/telegram`;
  console.log(`Setting webhook to: ${webhookUrl}`);
  makeTelegramRequest(`setWebhook?url=${encodeURIComponent(webhookUrl)}&drop_pending_updates=true`);
}

