/**
 * start-tunnel.js
 * Launches a Cloudflare tunnel (no IP verification pages, 100% webhook compatible)
 * and automatically configures Telegram's webhook.
 */

const { startTunnel } = require('untun');
const https = require('https');
const fs = require('fs');
const path = require('path');

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

async function setTelegramWebhook(tunnelUrl) {
  const webhookUrl = `${tunnelUrl.replace(/\/$/, '')}/api/telegram`;
  console.log(`\n🔗 Registering Telegram Webhook: ${webhookUrl}`);

  return new Promise((resolve, reject) => {
    const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}&drop_pending_updates=true`;
    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok) {
            console.log('✅ Webhook successfully connected to Telegram!');
          } else {
            console.error('❌ Telegram error:', json.description);
          }
          resolve(json);
        } catch (e) {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('🚀 Starting Cloudflare Tunnel for http://localhost:3000 ...');
  try {
    const tunnel = await startTunnel({
      port: 3000,
    });

    const tunnelUrl = await tunnel.getURL();
    console.log(`\n🌐 Public Tunnel URL: ${tunnelUrl}`);

    await setTelegramWebhook(tunnelUrl);

    console.log('\n======================================================');
    console.log(`🤖 Telegram Bot is LIVE and READY!`);
    console.log(`👉 Open: https://t.me/FinHelper11_bot`);
    console.log(`👉 Send: /start <your_username> (e.g. /start john)`);
    console.log('======================================================\n');
    console.log('Keep this terminal open while testing Telegram.');
  } catch (err) {
    console.error('Failed to start tunnel:', err);
  }
}

main();
