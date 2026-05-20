// FlipAlert Backend — Node.js + Express
// Run: npm install express node-cron axios cheerio puppeteer-core nodemailer
//      then: node server.js

const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());
app.use(require('cors')());

// ─── In-memory store (replace with PostgreSQL in production) ──────────────
const db = {
  users: [],
  alerts: [],
  seenListings: new Set(), // track IDs to avoid duplicate notifications
  listings: [],
  notifications: []
};

// ─── Normalize listing shape ───────────────────────────────────────────────
function makeId(platform, rawId) {
  return `${platform}::${rawId}`;
}

// ══════════════════════════════════════════════════════════════════════════
// SCRAPERS
// Each returns: [{ id, title, price, url, platform, image, location, postedAt }]
// ══════════════════════════════════════════════════════════════════════════

// ─── eBay ─────────────────────────────────────────────────────────────────
// Uses eBay's search page — very stable HTML structure
async function scrapeEbay(keyword, minPrice, maxPrice) {
  try {
    const q = encodeURIComponent(keyword);
    let url = `https://www.ebay.com/sch/i.html?_nkw=${q}&_sop=10&LH_BIN=1`;
    if (minPrice) url += `&_udlo=${minPrice}`;
    if (maxPrice) url += `&_udhi=${maxPrice}`;

    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 10000
    });

    const $ = cheerio.load(data);
    const results = [];

    $('.s-item').each((_, el) => {
      const title = $(el).find('.s-item__title').text().trim();
      if (!title || title === 'Shop on eBay') return;

      const priceText = $(el).find('.s-item__price').first().text().trim();
      const price = parseFloat(priceText.replace(/[^0-9.]/g, ''));
      const itemUrl = $(el).find('.s-item__link').attr('href')?.split('?')[0];
      const image = $(el).find('.s-item__image-img').attr('src');
      const location = $(el).find('.s-item__location').text().replace('from ', '').trim();
      const rawId = itemUrl?.match(/itm\/(\d+)/)?.[1] || Math.random().toString(36);

      if (minPrice && price < minPrice) return;
      if (maxPrice && price > maxPrice) return;

      results.push({
        id: makeId('ebay', rawId),
        title, price, url: itemUrl, image,
        location: location || 'eBay',
        platform: 'ebay',
        postedAt: new Date().toISOString(),
        keyword
      });
    });

    return results.slice(0, 20);
  } catch (e) {
    console.error('[eBay]', e.message);
    return [];
  }
}

// ─── Craigslist ───────────────────────────────────────────────────────────
// Uses RSS feed — the most reliable method, publicly documented
async function scrapeCraigslist(keyword, minPrice, maxPrice, city = 'newyork') {
  try {
    const q = encodeURIComponent(keyword);
    let url = `https://${city}.craigslist.org/search/sss?format=rss&query=${q}&sort=date`;
    if (minPrice) url += `&min_price=${minPrice}`;
    if (maxPrice) url += `&max_price=${maxPrice}`;

    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });

    const $ = cheerio.load(data, { xmlMode: true });
    const results = [];

    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim() || $(el).find('enclosure').attr('url');
      const pubDate = $(el).find('pubDate').text().trim();
      const desc = $(el).find('description').text();
      const priceMatch = (title + desc).match(/\$[\d,]+/);
      const price = priceMatch ? parseFloat(priceMatch[0].replace(/[^0-9.]/g, '')) : null;
      const rawId = link?.match(/\/(\d+)\.html/)?.[1] || Math.random().toString(36);
      const enclosureUrl = $(el).find('enclosure').attr('url');

      if (!title || !link) return;
      if (minPrice && price && price < minPrice) return;
      if (maxPrice && price && price > maxPrice) return;

      results.push({
        id: makeId('craigslist', rawId),
        title, price,
        url: link,
        image: enclosureUrl || null,
        location: city,
        platform: 'craigslist',
        postedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        keyword
      });
    });

    return results.slice(0, 20);
  } catch (e) {
    console.error('[Craigslist]', e.message);
    return [];
  }
}

// ─── OfferUp ─────────────────────────────────────────────────────────────
async function scrapeOfferUp(keyword, minPrice, maxPrice) {
  try {
    const q = encodeURIComponent(keyword);
    const url = `https://offerup.com/search/?q=${q}&sort=-published`;

    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: 10000
    });

    // OfferUp embeds data in __NEXT_DATA__ script tag
    const match = data.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) return [];

    const nextData = JSON.parse(match[1]);
    const items = nextData?.props?.pageProps?.initialSearchResults?.data?.results || [];
    const results = [];

    for (const r of items) {
      const item = r?.node?.item || r?.item;
      if (!item) continue;

      const price = item.price != null ? item.price / 100 : null;
      if (minPrice && price < minPrice) continue;
      if (maxPrice && price > maxPrice) continue;

      results.push({
        id: makeId('offerup', item.id),
        title: item.title || '',
        price,
        url: `https://offerup.com/item/detail/${item.id}`,
        image: item.photos?.[0]?.detail?.url || null,
        location: item.location?.city || '',
        platform: 'offerup',
        postedAt: item.created || new Date().toISOString(),
        keyword
      });
    }

    return results.slice(0, 20);
  } catch (e) {
    console.error('[OfferUp]', e.message);
    return [];
  }
}

// ─── Mercari ─────────────────────────────────────────────────────────────
async function scrapeMercari(keyword, minPrice, maxPrice) {
  try {
    const q = encodeURIComponent(keyword);
    const url = `https://www.mercari.com/search/?keyword=${q}&status=on_sale&sort_order=created_desc`;

    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        'Accept': 'text/html'
      },
      timeout: 10000
    });

    const match = data.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) return [];

    const nextData = JSON.parse(match[1]);
    const items = nextData?.props?.pageProps?.searchResult?.items || [];
    const results = [];

    for (const item of items) {
      const price = item.price ? parseFloat(item.price) : null;
      if (minPrice && price < minPrice) continue;
      if (maxPrice && price > maxPrice) continue;

      results.push({
        id: makeId('mercari', item.id),
        title: item.name || '',
        price,
        url: `https://www.mercari.com/us/item/${item.id}`,
        image: item.thumbnails?.[0] || null,
        location: item.shipsFrom || 'US',
        platform: 'mercari',
        postedAt: item.created ? new Date(item.created * 1000).toISOString() : new Date().toISOString(),
        keyword
      });
    }

    return results.slice(0, 20);
  } catch (e) {
    console.error('[Mercari]', e.message);
    return [];
  }
}

// ─── Facebook Marketplace ─────────────────────────────────────────────────
// Strategy: User's own FB session cookie (from OAuth login in app).
// We request Marketplace search pages ON BEHALF of the authenticated user.
// This is the user browsing their own account — same as them doing it manually.
//
// Cookie refresh: When user logs in via FB OAuth in the app, we extract and
// store their c_user + xs cookies (these are the session identifiers FB uses).
// We refresh them periodically by re-authenticating silently in the background.
//
// Parser targets the __bbox JSON blobs FB embeds in every page.
// When FB updates their frontend, only the JSON keys change — easy to patch.

async function scrapeFacebook(keyword, minPrice, maxPrice, userFbCookie) {
  if (!userFbCookie) {
    console.log('[Facebook] No cookie — skipping');
    return [];
  }

  try {
    const q = encodeURIComponent(keyword);
    // FB Marketplace search URL — works with session cookie
    const url = `https://www.facebook.com/marketplace/search/?query=${q}&sortBy=creation_time_descend`;

    const { data, status } = await axios.get(url, {
      headers: {
        'Cookie': userFbCookie,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.facebook.com/',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'navigate'
      },
      timeout: 15000,
      maxRedirects: 3
    });

    if (status !== 200) return [];

    const results = [];

    // ── Strategy 1: Extract from __bbox JSON blobs (FB's primary data format)
    const bboxMatches = [...data.matchAll(/"__bbox":\{"require":([\s\S]*?),"define"/g)];
    for (const m of bboxMatches) {
      try {
        // Look for listing data within bbox
        const listingData = m[1].match(/"listing_id":"(\d+)","name":"([^"]+)"[\s\S]*?"amount":"([^"]+)"/);
        if (listingData) {
          const price = parseFloat(listingData[3].replace(/[^0-9.]/g, ''));
          if (minPrice && price < minPrice) continue;
          if (maxPrice && price > maxPrice) continue;
          results.push({
            id: makeId('facebook', listingData[1]),
            title: listingData[2],
            price,
            url: `https://www.facebook.com/marketplace/item/${listingData[1]}`,
            image: null,
            location: '',
            platform: 'facebook',
            postedAt: new Date().toISOString(),
            keyword
          });
        }
      } catch (_) {}
    }

    // ── Strategy 2: Targeted JSON extraction from page scripts
    if (results.length === 0) {
      const scriptMatches = [...data.matchAll(/\{"marketplace_listing_seller"[\s\S]*?"id":"(\d+)"[\s\S]*?"name":"([^"]+)"[\s\S]*?"amount":"([^"]+)"/g)];
      for (const m of scriptMatches) {
        try {
          const price = parseFloat(m[3].replace(/[^0-9.]/g, ''));
          if (minPrice && price < minPrice) continue;
          if (maxPrice && price > maxPrice) continue;
          results.push({
            id: makeId('facebook', m[1]),
            title: m[2],
            price,
            url: `https://www.facebook.com/marketplace/item/${m[1]}`,
            image: null,
            location: '',
            platform: 'facebook',
            postedAt: new Date().toISOString(),
            keyword
          });
        } catch (_) {}
      }
    }

    // ── Strategy 3: Regex fallback — listing IDs + titles
    if (results.length === 0) {
      const idTitlePairs = [...data.matchAll(/"listing_id":"(\d+)"[\s\S]{0,200}?"name":"([^"]+)"/g)];
      for (const m of idTitlePairs.slice(0, 20)) {
        results.push({
          id: makeId('facebook', m[1]),
          title: m[2],
          price: null,
          url: `https://www.facebook.com/marketplace/item/${m[1]}`,
          image: null,
          location: '',
          platform: 'facebook',
          postedAt: new Date().toISOString(),
          keyword
        });
      }
    }

    console.log(`[Facebook] Found ${results.length} listings for "${keyword}"`);
    return results.slice(0, 20);

  } catch (e) {
    console.error('[Facebook]', e.message);
    // If we get a redirect to login, the cookie has expired
    if (e.response?.status === 302 || e.message.includes('302')) {
      console.warn('[Facebook] Session expired — user needs to re-authenticate');
      // TODO: trigger re-auth notification to user
    }
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════════
// MONITORING ENGINE
// Runs every N minutes per alert config
// ══════════════════════════════════════════════════════════════════════════

async function runAlert(alert) {
  if (!alert.active) return;

  console.log(`[Monitor] Running alert "${alert.name}" | keywords: ${alert.keywords.join(', ')}`);
  const allNew = [];

  for (const keyword of alert.keywords) {
    const scrapers = [];

    if (alert.platforms.includes('facebook') && alert.fbCookie) {
      scrapers.push(scrapeFacebook(keyword, alert.minPrice, alert.maxPrice, alert.fbCookie));
    }
    if (alert.platforms.includes('ebay')) {
      scrapers.push(scrapeEbay(keyword, alert.minPrice, alert.maxPrice));
    }
    if (alert.platforms.includes('craigslist')) {
      scrapers.push(scrapeCraigslist(keyword, alert.minPrice, alert.maxPrice, alert.location));
    }
    if (alert.platforms.includes('offerup')) {
      scrapers.push(scrapeOfferUp(keyword, alert.minPrice, alert.maxPrice));
    }
    if (alert.platforms.includes('mercari')) {
      scrapers.push(scrapeMercari(keyword, alert.minPrice, alert.maxPrice));
    }

    const results = await Promise.allSettled(scrapers);
    const listings = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

    // Filter to genuinely new listings only
    const newListings = listings.filter(l => !db.seenListings.has(l.id));
    newListings.forEach(l => {
      db.seenListings.add(l.id);
      db.listings.unshift(l);
    });

    allNew.push(...newListings);
  }

  if (allNew.length > 0) {
    console.log(`[Monitor] Alert "${alert.name}" → ${allNew.length} NEW listings`);
    alert.lastTriggered = new Date().toISOString();
    alert.matchCount = (alert.matchCount || 0) + allNew.length;

    // Send notifications
    await sendNotifications(alert, allNew);
  }

  // Keep db from growing unbounded
  if (db.listings.length > 5000) db.listings = db.listings.slice(0, 5000);

  return allNew;
}

// ══════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════════════

async function sendNotifications(alert, newListings) {
  const user = db.users.find(u => u.id === alert.userId);
  if (!user) return;

  const topListing = newListings[0];
  const message = `${newListings.length} new match${newListings.length > 1 ? 'es' : ''} for "${alert.name}": ${topListing.title} — $${topListing.price || 'N/A'}`;

  // ── Push notification (Firebase FCM)
  if (user.fcmToken && user.settings?.push !== false) {
    await sendPush(user.fcmToken, {
      title: `🔥 FlipAlert: ${alert.name}`,
      body: message,
      data: { alertId: alert.id, listingId: topListing.id, platform: topListing.platform }
    });
  }

  // ── Email
  if (user.email && user.settings?.email !== false) {
    await sendEmail(user.email, alert, newListings);
  }

  // ── SMS (Twilio)
  if (user.phone && user.settings?.sms === true) {
    await sendSMS(user.phone, message);
  }

  // Store in notification log
  db.notifications.push({
    id: Date.now(),
    userId: user.id,
    alertId: alert.id,
    message,
    listings: newListings.map(l => l.id),
    sentAt: new Date().toISOString(),
    read: false
  });
}

// ── FCM Push ──────────────────────────────────────────────────────────────
async function sendPush(fcmToken, { title, body, data }) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (!serviceAccount.private_key) return;

    // Get OAuth token for V1 API
    const jwt = await getFirebaseJWT(serviceAccount);
    const projectId = serviceAccount.project_id;

    await axios.post(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        message: {
          token: fcmToken,
          notification: { title, body },
          data: data || {}
        }
      },
      { headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('[Push]', e.message);
  }
}

async function getFirebaseJWT(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })).toString('base64url');

  const crypto = require('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(serviceAccount.private_key, 'base64url');
  const jwt = `${header}.${payload}.${signature}`;

  const resp = await axios.post('https://oauth2.googleapis.com/token',
    new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  );
  return resp.data.access_token;
}

// ── Email (SendGrid) ─────────────────────────────────────────────────────
async function sendEmail(to, alert, listings) {
  try {
    const listingRows = listings.slice(0, 5).map(l =>
      `<tr>
        <td style="padding:12px;border-bottom:1px solid #eee;">
          <strong>${l.title}</strong><br>
          <span style="color:#00c278;font-size:18px;font-weight:bold;">$${l.price || 'N/A'}</span>
          &nbsp; <span style="color:#999;font-size:12px;">${l.platform} • ${l.location}</span>
        </td>
        <td style="padding:12px;border-bottom:1px solid #eee;text-align:right;">
          <a href="${l.url}" style="background:#00c278;color:#000;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:13px;">View Deal</a>
        </td>
      </tr>`
    ).join('');

    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#0a0a0f;padding:24px;border-radius:12px 12px 0 0;">
          <h1 style="color:#00e5a0;margin:0;font-size:28px;">FlipAlert 🔥</h1>
          <p style="color:#888;margin:4px 0 0;">${listings.length} new match${listings.length>1?'es':''} for <strong style="color:#fff;">"${alert.name}"</strong></p>
        </div>
        <div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;overflow:hidden;">
          <table style="width:100%;border-collapse:collapse;">${listingRows}</table>
          ${listings.length > 5 ? `<p style="padding:12px;color:#999;font-size:13px;">+${listings.length-5} more listings in the app</p>` : ''}
        </div>
      </div>`;

    await axios.post('https://api.sendgrid.com/v3/mail/send', {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: 'alerts@flipalert.app', name: 'FlipAlert' },
      subject: `🔥 ${listings.length} new deal${listings.length>1?'s':''} for "${alert.name}"`,
      content: [{ type: 'text/html', value: html }]
    }, {
      headers: { 'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}` }
    });
  } catch (e) {
    console.error('[Email]', e.message);
  }
}

// ── SMS (Twilio) ──────────────────────────────────────────────────────────
async function sendSMS(to, message) {
  try {
    const accountSid = process.env.TWILIO_SID;
    const authToken = process.env.TWILIO_TOKEN;
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      new URLSearchParams({ To: to, From: process.env.TWILIO_PHONE, Body: `FlipAlert: ${message}` }),
      { auth: { username: accountSid, password: authToken } }
    );
  } catch (e) {
    console.error('[SMS]', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// SCHEDULER
// Runs all active alerts on their configured interval
// Default: every 15 minutes. Pro users: every 5 minutes.
// ══════════════════════════════════════════════════════════════════════════

cron.schedule('*/15 * * * *', async () => {
  console.log('[Scheduler] Running 15-min cycle...');
  const activeAlerts = db.alerts.filter(a => a.active && a.frequency !== 5);
  for (const alert of activeAlerts) {
    await runAlert(alert);
    // Stagger to avoid hammering platforms simultaneously
    await new Promise(r => setTimeout(r, 2000));
  }
});

cron.schedule('*/5 * * * *', async () => {
  const proAlerts = db.alerts.filter(a => a.active && a.frequency === 5);
  for (const alert of proAlerts) {
    await runAlert(alert);
    await new Promise(r => setTimeout(r, 1000));
  }
});

// ══════════════════════════════════════════════════════════════════════════
// REST API
// ══════════════════════════════════════════════════════════════════════════

// Auth
app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body;
  if (db.users.find(u => u.email === email)) return res.status(400).json({ error: 'Email exists' });
  const user = { id: Date.now().toString(), email, name, password, settings: { push: true, email: true, sms: false }, createdAt: new Date().toISOString() };
  db.users.push(user);
  res.json({ user: { ...user, password: undefined }, token: `token_${user.id}` });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.users.find(u => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ user: { ...user, password: undefined }, token: `token_${user.id}` });
});

// Facebook session — called after user completes FB OAuth in app
// The app extracts the session cookies from the in-app browser and sends here
app.post('/api/auth/facebook-session', authMiddleware, (req, res) => {
  const { cookie } = req.body; // c_user and xs cookies
  req.user.fbCookie = cookie;
  req.user.fbConnected = true;
  res.json({ success: true });
});

// Alerts
app.get('/api/alerts', authMiddleware, (req, res) => {
  res.json(db.alerts.filter(a => a.userId === req.user.id));
});

app.post('/api/alerts', authMiddleware, (req, res) => {
  const alert = {
    id: Date.now().toString(),
    userId: req.user.id,
    fbCookie: req.user.fbCookie || null,
    ...req.body,
    active: true,
    matchCount: 0,
    createdAt: new Date().toISOString()
  };
  db.alerts.push(alert);
  // Run immediately on creation
  runAlert(alert);
  res.json(alert);
});

app.patch('/api/alerts/:id', authMiddleware, (req, res) => {
  const alert = db.alerts.find(a => a.id === req.params.id && a.userId === req.user.id);
  if (!alert) return res.status(404).json({ error: 'Not found' });
  Object.assign(alert, req.body);
  res.json(alert);
});

app.delete('/api/alerts/:id', authMiddleware, (req, res) => {
  db.alerts = db.alerts.filter(a => !(a.id === req.params.id && a.userId === req.user.id));
  res.json({ success: true });
});

// Listings feed
app.get('/api/listings', authMiddleware, (req, res) => {
  const { platform, limit = 50, offset = 0 } = req.query;
  const userAlerts = db.alerts.filter(a => a.userId === req.user.id);
  const userKeywords = new Set(userAlerts.flatMap(a => a.keywords.map(k => k.toLowerCase())));

  let listings = db.listings.filter(l =>
    userKeywords.has(l.keyword?.toLowerCase()) ||
    [...userKeywords].some(kw => l.title.toLowerCase().includes(kw))
  );

  if (platform) listings = listings.filter(l => l.platform === platform);
  res.json({ listings: listings.slice(Number(offset), Number(offset)+Number(limit)), total: listings.length });
});

// Notifications
app.get('/api/notifications', authMiddleware, (req, res) => {
  res.json(db.notifications.filter(n => n.userId === req.user.id).slice(0, 50));
});

app.post('/api/notifications/read', authMiddleware, (req, res) => {
  db.notifications.filter(n => n.userId === req.user.id).forEach(n => n.read = true);
  res.json({ success: true });
});

// FCM token registration
app.post('/api/devices/register', authMiddleware, (req, res) => {
  req.user.fcmToken = req.body.fcmToken;
  res.json({ success: true });
});

// Settings
app.patch('/api/settings', authMiddleware, (req, res) => {
  Object.assign(req.user.settings, req.body);
  res.json(req.user.settings);
});

// Manual trigger (for testing)
app.post('/api/alerts/:id/run', authMiddleware, async (req, res) => {
  const alert = db.alerts.find(a => a.id === req.params.id && a.userId === req.user.id);
  if (!alert) return res.status(404).json({ error: 'Not found' });
  const newListings = await runAlert(alert);
  res.json({ newListings: newListings.length, listings: newListings });
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', alerts: db.alerts.length, listings: db.listings.length }));

// ─── Auth middleware ───────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const userId = token.replace('token_', '');
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`FlipAlert backend running on :${PORT}`));

module.exports = { scrapeEbay, scrapeCraigslist, scrapeOfferUp, scrapeMercari, scrapeFacebook };


// ══════════════════════════════════════════════════════
// POLL ENDPOINT
// Called by the frontend every N minutes per user
// Returns ONLY new listings not in seenIds
// Every listing MUST have a direct .url to the specific item
// ══════════════════════════════════════════════════════

app.post('/api/listings/poll', async (req, res) => {
  const { alerts, seenIds = [], fbToken } = req.body;
  if (!alerts?.length) return res.json({ listings: [] });

  const seen = new Set(seenIds);
  const allNew = [];

  for (const alert of alerts) {
    if (!alert.active) continue;
    for (const keyword of alert.keywords) {
      const scrapers = [];

      // Facebook — uses user's own FB token/session
      if (alert.platforms.includes('facebook') && fbToken) {
        scrapers.push(scrapeFacebook(keyword, alert.minPrice, alert.maxPrice, fbToken));
      }
      if (alert.platforms.includes('ebay')) {
        scrapers.push(scrapeEbay(keyword, alert.minPrice, alert.maxPrice));
      }
      // For Craigslist, search each city separately
      const cities = alert.cities?.length ? alert.cities : [alert.location || 'newyork'];
      if (alert.platforms.includes('craigslist')) {
        cities.forEach(city => {
          // Normalize city name to craigslist subdomain format
          const cl_city = city.toLowerCase().replace(/\s+/g, '').replace(/,.*$/, '');
          scrapers.push(scrapeCraigslist(keyword, alert.minPrice, alert.maxPrice, cl_city));
        });
      }
      if (alert.platforms.includes('offerup')) {
        scrapers.push(scrapeOfferUp(keyword, alert.minPrice, alert.maxPrice));
      }
      if (alert.platforms.includes('mercari')) {
        scrapers.push(scrapeMercari(keyword, alert.minPrice, alert.maxPrice));
      }

      const results = await Promise.allSettled(scrapers);
      const listings = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

      // Only return listings we haven't seen before AND that have a real URL
      listings.forEach(l => {
        if (!seen.has(l.id) && l.url && l.url !== '#') {
          l.foundAt = new Date().toISOString();
          allNew.push(l);
          seen.add(l.id);
        }
      });
    }
  }

  // Sort by newest first
  allNew.sort((a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0));

  res.json({ listings: allNew.slice(0, 50) });
});
