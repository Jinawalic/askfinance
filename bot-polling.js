/**
 * bot-polling.js
 * High-performance, zero-tunnel local development runner using Telegram Long-Polling.
 * Uses native Node https for instant response times.
 */

const https = require('https');
const http = require('http');
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
let offset = 0;
let isRunning = true;

function apiCall(endpoint, payload = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${BOT_TOKEN}/${endpoint}`,
      method: payload ? 'POST' : 'GET',
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(payload)),
      } : {},
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ ok: false, error: data });
        }
      });
    });

    req.on('error', reject);
    if (payload) {
      req.write(JSON.stringify(payload));
    }
    req.end();
  });
}

function forwardToLocalApp(update) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(update);
    const options = {
      hostname: '127.0.0.1',
      port: 3000,
      path: '/api/telegram',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', (err) => {
      console.error(`❌ [Local server connection error]: ${err.message}`);
      console.error('👉 Make sure "npm run dev" is running at http://localhost:3000!');
      resolve({ error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

async function setup() {
  console.log('🤖 Initializing Direct Telegram Polling (No tunnel required!)...');
  try {
    const delRes = await apiCall('deleteWebhook?drop_pending_updates=false');
    if (delRes.ok) {
      console.log('✅ Previous webhook cleared.');
    }
    const meRes = await apiCall('getMe');
    const username = meRes.result?.username || 'FinanceBot';
    console.log('\n======================================================');
    console.log(`🎉 Bot is LIVE in local polling mode!`);
    console.log(`👉 Bot: @${username} (https://t.me/${username})`);
    console.log(`👉 Forwarding directly to: http://127.0.0.1:3000/api/telegram`);
    console.log('======================================================\n');
    console.log('Listening for Telegram messages (Press Ctrl+C to stop)...\n');
  } catch (err) {
    console.error('Setup error:', err.message);
  }
}

async function pollLoop() {
  while (isRunning) {
    try {
      const res = await apiCall(`getUpdates?offset=${offset}&timeout=20`);
      if (res && res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          offset = update.update_id + 1;
          const sender = update.message?.from?.username || update.message?.from?.first_name || 'User';
          const text = update.message?.text || (update.message?.document ? `[PDF: ${update.message.document.file_name}]` : '[Update]');
          console.log(`📩 Received from @${sender}: "${text}"`);

          const result = await forwardToLocalApp(update);
          if (result.status === 200) {
            console.log(`⚡ Bot replied successfully.`);
          }
        }
      }
    } catch (err) {
      console.error('Polling connection notice:', err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  await setup();
  pollLoop();
}

process.on('SIGINT', () => {
  console.log('\nStopping bot polling...');
  isRunning = false;
  process.exit(0);
});

main();
