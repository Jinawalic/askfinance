/**
 * set-webhook.js
 * Run this whenever you start a new localtunnel session to update Telegram's webhook.
 *
 * Usage:
 *   node set-webhook.js https://your-tunnel-url.loca.lt
 *
 * Or with auto-detection (reads the tunnel URL from the running localtunnel process):
 *   node set-webhook.js
 */

const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8767722632:AAERn7tPHJOXgOXXiNRuT0Sf8GPsn4rwO90';
const tunnelUrl = process.argv[2];

if (!tunnelUrl) {
  console.error('Usage: node set-webhook.js https://<your-tunnel>.loca.lt');
  process.exit(1);
}

const webhookUrl = `${tunnelUrl.replace(/\/$/, '')}/api/telegram`;
const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;

console.log(`Setting webhook to: ${webhookUrl}`);

https.get(apiUrl, (res) => {
  let data = '';
  res.on('data', (chunk) => (data += chunk));
  res.on('end', () => {
    const result = JSON.parse(data);
    if (result.ok) {
      console.log('✅ Webhook set successfully!');
    } else {
      console.error('❌ Failed:', result.description);
    }
  });
}).on('error', (err) => {
  console.error('Request error:', err.message);
});
