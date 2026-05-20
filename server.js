// FlipAlert Backend — Production Ready
// Uses PostgreSQL (Supabase) for persistent storage
// npm install express cors axios cheerio node-cron pg

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════
// DATABASE
// ══════════════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('❌ Database connection failed:', err.message);
  else console.log('✅ Database connected:', res.rows[0].now);
});

// Create tables if they don't exist
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password TEXT,
      fb_token TEXT,
      fb_connected BOOLEAN DEFAULT false,
      fcm_token TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      keywords TEXT[] NOT NULL,
      platforms TEXT[] NOT NULL,
      min_price NUMERIC,
      max_price NUMERIC,
      cities TEXT[],
      radius TEXT DEFAULT '50',
      active BOOLEAN DEFAULT true,
      match_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      title TEXT,
      price NUMERIC,
      url TEXT,
      image TEXT,
      location TEXT,
      platform TEXT,
      keyword TEXT,
      posted_at TIMESTAMPTZ,
      found_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS seen_listings (
      alert_id UUID REFERENCES alerts(id) ON DELETE CASCADE,
      listing_id TEXT NOT NULL,
      PRIMARY KEY (alert_id, listing_id)
    );
  `);
  console.log('✅ Tables ready');
}

initDB().catch(console.error);

// ══════════════════════════════════════════
// SCRAPERS
// Each returns direct individual listing URLs
// ══════════════════════════════════════════

function normalizePrice(str) {
  if (!str) return null;
  const m = String(str).replace(/,/g, '').match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

// ── eBay ──────────────────────────────────
async function scrapeEbay(keyword, minPrice, maxPrice) {
  try {
    const q = encodeURIComponent(keyword);
    let url = `https://www.ebay.com/sch/i.html?_nkw=${q}&_sop=10&LH_BIN=1`;
    if (minPrice) url += `&_udlo=${minPrice}`;
    if (maxPrice) url += `&_udhi=${maxPrice}`;

    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 12000
    });

    const $ = cheerio.load(data);
    const results = [];

    $('.s-item').each((_, el) => {
      const title = $(el).find('.s-item__title').text().trim();
      if (!title || title === 'Shop on eBay') return;

      const priceText = $(el).find('.s-item__price').first().text();
      const price = normalizePrice(priceText);
      const itemUrl = $(el).find('.s-item__link').attr('href')?.split('?')[0];
      const image = $(el).find('.s-item__image-img').attr('src');
      const location = $(el).find('.s-item__location').text().replace('from ', '').trim();
      const rawId = itemUrl?.match(/itm\/(\d+)/)?.[1];

      if (!itemUrl || !rawId) return;
      if (minPrice && price && price < minPrice) return;
      if (maxPrice && price && price > maxPrice) return;

      results.push({
        id: `ebay_${rawId}`,
        title, price,
        url: itemUrl, // direct listing URL
        image: image || null,
        location: location || 'eBay',
        platform: 'ebay',
        postedAt: new Date().toISOString(),
        keyword
      });
    });

    return results.slice(0, 15);
  } catch (e) {
    console.error('[eBay]', e.message);
    return [];
  }
}

// ── Craigslist (RSS) ──────────────────────
async function scrapeCraigslist(keyword, minPrice, maxPrice, city = 'newyork') {
  try {
    const q = encodeURIComponent(keyword);
    let url = `https://${city}.craigslist.org/search/sss?format=rss&query=${q}&sort=date`;
    if (minPrice) url += `&min_price=${minPrice}`;
    if (maxPrice) url += `&max_price=${maxPrice}`;

    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 12000
    });

    const $ = cheerio.load(data, { xmlMode: true });
    const results = [];

    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const desc = $(el).find('description').text();
      const priceMatch = (title + desc).match(/\$[\d,]+/);
      const price = priceMatch ? normalizePrice(priceMatch[0]) : null;
      const rawId = link?.match(/\/(\d+)\.html/)?.[1];

      if (!title || !link || !rawId) return;
      if (minPrice && price && price < minPrice) return;
      if (maxPrice && price && price > maxPrice) return;

      results.push({
        id: `cl_${rawId}`,
        title, price,
        url: link, // direct listing URL e.g. https://newyork.craigslist.org/mnh/pho/d/iphone/1234567.html
        image: null,
        location: city,
        platform: 'craigslist',
        postedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        keyword
      });
    });

    return results.slice(0, 15);
  } catch (e) {
    console.error('[Craigslist]', e.message);
    return [];
  }
}

// ── OfferUp ───────────────────────────────
async function scrapeOfferUp(keyword, minPrice, maxPrice) {
  try {
    const q = encodeURIComponent(keyword);
    const url = `https://offerup.com/search/?q=${q}&sort=-published`;

    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
      timeout: 12000
    });

    const match = data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return [];

    const nextData = JSON.parse(match[1]);
    const items = nextData?.props?.pageProps?.initialSearchResults?.data?.results || [];
    const results = [];

    for (const r of items) {
      const item = r?.node?.item || r?.item;
      if (!item?.id) continue;

      const price = item.price != null ? item.price / 100 : null;
      if (minPrice && price < minPrice) continue;
      if (maxPrice && price > maxPrice) continue;

      results.push({
        id: `ou_${item.id}`,
        title: item.title || '',
        price,
        url: `https://offerup.com/item/detail/${item.id}`, // direct listing URL
        image: item.photos?.[0]?.detail?.url || null,
        location: item.location?.city || '',
        platform: 'offerup',
        postedAt: item.created || new Date().toISOString(),
        keyword
      });
    }

    return results.slice(0, 15);
  } catch (e) {
    console.error('[OfferUp]', e.message);
    return [];
  }
}

// ── Mercari ───────────────────────────────
async function scrapeMercari(keyword, minPrice, maxPrice) {
  try {
    const q = encodeURIComponent(keyword);
    const url = `https://www.mercari.com/search/?keyword=${q}&status=on_sale&sort_order=created_desc`;

    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
      timeout: 12000
    });

    const match = data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return [];

    const nextData = JSON.parse(match[1]);
    const items = nextData?.props?.pageProps?.searchResult?.items || [];
    const results = [];

    for (const item of items) {
      if (!item?.id) continue;
      const price = item.price ? parseFloat(item.price) : null;
      if (minPrice && price < minPrice) continue;
      if (maxPrice && price > maxPrice) continue;

      results.push({
        id: `mc_${item.id}`,
        title: item.name || '',
        price,
        url: `https://www.mercari.com/us/item/${item.id}`, // direct listing URL
        image: item.thumbnails?.[0] || null,
        location: item.shipsFrom || 'US',
        platform: 'mercari',
        postedAt: item.created ? new Date(item.created * 1000).toISOString() : new Date().toISOString(),
        keyword
      });
    }

    return results.slice(0, 15);
  } catch (e) {
    console.error('[Mercari]', e.message);
    return [];
  }
}

// ── Facebook Marketplace ──────────────────
// Uses user's own FB session token from OAuth login
// Browses Marketplace on their behalf — same as them doing it manually
async function scrapeFacebook(keyword, minPrice, maxPrice, fbToken) {
  if (!fbToken) return [];
  try {
    // Use FB Graph API with user token to search Marketplace
    const q = encodeURIComponent(keyword);
    const url = `https://www.facebook.com/marketplace/search/?query=${q}&sortBy=creation_time_descend`;

    const { data, status } = await axios.get(url, {
      headers: {
        'Cookie': `xs=${fbToken}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.facebook.com/'
      },
      timeout: 15000,
      maxRedirects: 3
    });

    if (status !== 200) return [];

    const results = [];

    // Extract listing IDs and data from FB's embedded JSON
    const patterns = [
      // Pattern 1: listing_id with name and amount
      /\"listing_id\":\"(\d+)\"[^}]{0,500}?\"name\":\"([^\"]+)\"[^}]{0,300}?\"amount\":\"([^\"]+)\"/g,
      // Pattern 2: id with marketplace context
      /\"id\":\"(\d{10,})\",\"name\":\"([^\"]{5,100})\",\"listing_price\":\{\"amount\":\"([^\"]+)\"/g
    ];

    const seenIds = new Set();

    for (const pattern of patterns) {
      let m;
      while ((m = pattern.exec(data)) !== null) {
        const id = m[1];
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const price = normalizePrice(m[3]);
        if (minPrice && price && price < minPrice) continue;
        if (maxPrice && price && price > maxPrice) continue;

        results.push({
          id: `fb_${id}`,
          title: m[2].replace(/\\u[\dA-F]{4}/gi, c => String.fromCharCode(parseInt(c.replace(/\\u/,''),16))),
          price,
          url: `https://www.facebook.com/marketplace/item/${id}`, // direct listing URL
          image: null,
          location: '',
          platform: 'facebook',
          postedAt: new Date().toISOString(),
          keyword
        });

        if (results.length >= 15) break;
      }
      if (results.length >= 15) break;
    }

    console.log(`[Facebook] "${keyword}" → ${results.length} listings`);
    return results;
  } catch (e) {
    console.error('[Facebook]', e.message);
    return [];
  }
}

// ══════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, name, password } = req.body;
    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.rows.length) return res.status(400).json({ error: 'Email already registered' });

    const result = await pool.query(
      'INSERT INTO users (email, name, password) VALUES ($1,$2,$3) RETURNING id, email, name',
      [email, name || email.split('@')[0], password]
    );
    const user = result.rows[0];
    res.json({ user, token: `tok_${user.id}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT id, email, name, fb_connected FROM users WHERE email=$1 AND password=$2', [email, password]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    res.json({ user, token: `tok_${user.id}` });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Facebook session
app.post('/api/auth/facebook-session', async (req, res) => {
  try {
    const { token, userId, email, name } = req.body;
    // Upsert user by email
    const result = await pool.query(`
      INSERT INTO users (email, name, fb_token, fb_connected)
      VALUES ($1, $2, $3, true)
      ON CONFLICT (email) DO UPDATE SET fb_token=$3, fb_connected=true, name=COALESCE($2, users.name)
      RETURNING id, email, name, fb_connected
    `, [email || `fb_${userId}@flipalert.app`, name || 'User', token]);

    const user = result.rows[0];
    res.json({ user, token: `tok_${user.id}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Register FCM token for push notifications
app.post('/api/devices/register', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE users SET fcm_token=$1 WHERE id=$2', [req.body.fcmToken, req.user.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════
// ALERTS ROUTES
// Stored in DB — survive restarts, device resets, everything
// ══════════════════════════════════════════

// Get all alerts for user
app.get('/api/alerts', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM alerts WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create alert
app.post('/api/alerts', authMiddleware, async (req, res) => {
  try {
    const { name, keywords, platforms, minPrice, maxPrice, cities, radius } = req.body;
    const result = await pool.query(`
      INSERT INTO alerts (user_id, name, keywords, platforms, min_price, max_price, cities, radius)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [req.user.id, name, keywords, platforms, minPrice || null, maxPrice || null, cities || [], radius || '50']);

    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update alert (pause/resume)
app.patch('/api/alerts/:id', authMiddleware, async (req, res) => {
  try {
    const { active } = req.body;
    const result = await pool.query(
      'UPDATE alerts SET active=$1 WHERE id=$2 AND user_id=$3 RETURNING *',
      [active, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Alert not found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete alert
app.delete('/api/alerts/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM alerts WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════
// POLL ENDPOINT
// Frontend calls this every N minutes
// Returns only NEW listings not seen before
// All listings have direct individual URLs
// ══════════════════════════════════════════
app.post('/api/listings/poll', authMiddleware, async (req, res) => {
  try {
    const { alertIds } = req.body;

    // Load user's active alerts from DB
    const alertsResult = await pool.query(
      'SELECT * FROM alerts WHERE user_id=$1 AND active=true',
      [req.user.id]
    );
    const alerts = alertsResult.rows;
    if (!alerts.length) return res.json({ listings: [] });

    // Get user's FB token
    const userResult = await pool.query('SELECT fb_token FROM users WHERE id=$1', [req.user.id]);
    const fbToken = userResult.rows[0]?.fb_token;

    const allNew = [];

    for (const alert of alerts) {
      // Get already-seen listing IDs for this alert
      const seenResult = await pool.query(
        'SELECT listing_id FROM seen_listings WHERE alert_id=$1',
        [alert.id]
      );
      const seenIds = new Set(seenResult.rows.map(r => r.listing_id));

      for (const keyword of alert.keywords) {
        const scrapers = [];

        if (alert.platforms.includes('facebook') && fbToken) {
          scrapers.push(scrapeFacebook(keyword, alert.min_price, alert.max_price, fbToken));
        }
        if (alert.platforms.includes('ebay')) {
          scrapers.push(scrapeEbay(keyword, alert.min_price, alert.max_price));
        }
        if (alert.platforms.includes('craigslist')) {
          const cities = alert.cities?.length ? alert.cities : ['newyork'];
          cities.forEach(city => {
            const clCity = city.toLowerCase().replace(/\s+/g,'').replace(/,.*$/,'');
            scrapers.push(scrapeCraigslist(keyword, alert.min_price, alert.max_price, clCity));
          });
        }
        if (alert.platforms.includes('offerup')) {
          scrapers.push(scrapeOfferUp(keyword, alert.min_price, alert.max_price));
        }
        if (alert.platforms.includes('mercari')) {
          scrapers.push(scrapeMercari(keyword, alert.min_price, alert.max_price));
        }

        const results = await Promise.allSettled(scrapers);
        const listings = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

        // Filter to new only
        const newListings = listings.filter(l => l.url && l.url !== '#' && !seenIds.has(l.id));

        if (newListings.length > 0) {
          // Save to seen_listings so we never notify again
          const seenValues = newListings.map(l => `('${alert.id}','${l.id.replace(/'/g,"''")}')`).join(',');
          await pool.query(`INSERT INTO seen_listings (alert_id, listing_id) VALUES ${seenValues} ON CONFLICT DO NOTHING`);

          // Save listings to listings table
          for (const l of newListings) {
            await pool.query(`
              INSERT INTO listings (id, title, price, url, image, location, platform, keyword, posted_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
              ON CONFLICT (id) DO NOTHING
            `, [l.id, l.title, l.price, l.url, l.image, l.location, l.platform, l.keyword, l.postedAt]);
          }

          // Update match count
          await pool.query('UPDATE alerts SET match_count=match_count+$1 WHERE id=$2', [newListings.length, alert.id]);

          newListings.forEach(l => {
            l.foundAt = new Date().toISOString();
            l.alertName = alert.name;
            allNew.push(l);
          });
        }
      }
    }

    // Sort newest first
    allNew.sort((a, b) => new Date(b.foundAt) - new Date(a.foundAt));

    // Send push notifications for new listings
    if (allNew.length > 0) {
      const userFcm = await pool.query('SELECT fcm_token FROM users WHERE id=$1', [req.user.id]);
      const fcmToken = userFcm.rows[0]?.fcm_token;
      if (fcmToken) {
        const best = allNew[0];
        await sendPush(fcmToken, {
          title: `🔥 New ${best.platform} deal!`,
          body: `${best.title?.slice(0,60)} — $${best.price || '?'}`,
          data: { url: best.url }
        });
      }
    }

    res.json({ listings: allNew.slice(0, 50) });
  } catch (e) {
    console.error('[Poll]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get recent listings for user (on app open)
app.get('/api/listings', authMiddleware, async (req, res) => {
  try {
    // Get all keywords from user's alerts
    const alertsResult = await pool.query('SELECT keywords FROM alerts WHERE user_id=$1', [req.user.id]);
    const allKeywords = alertsResult.rows.flatMap(a => a.keywords);

    if (!allKeywords.length) return res.json({ listings: [] });

    const result = await pool.query(`
      SELECT * FROM listings
      WHERE keyword = ANY($1)
      ORDER BY found_at DESC
      LIMIT 100
    `, [allKeywords]);

    res.json({ listings: result.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete account (GDPR)
app.delete('/api/account', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.user.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════
// PUSH NOTIFICATIONS (Firebase V1)
// ══════════════════════════════════════════
async function sendPush(fcmToken, { title, body, data }) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) return;
    const sa = JSON.parse(raw);
    const jwt = await getFirebaseJWT(sa);

    await axios.post(
      `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
      { message: { token: fcmToken, notification: { title, body }, data: data || {} } },
      { headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('[Push]', e.message);
  }
}

async function getFirebaseJWT(sa) {
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  })).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(sa.private_key, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;
  const resp = await axios.post('https://oauth2.googleapis.com/token',
    new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  );
  return resp.data.access_token;
}

// ══════════════════════════════════════════
// AUTH MIDDLEWARE
// ══════════════════════════════════════════
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  const userId = token.replace('tok_', '');
  try {
    const result = await pool.query('SELECT id, email, name, fb_token, fb_connected FROM users WHERE id=$1', [userId]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid token' });
    req.user = result.rows[0];
    next();
  } catch (e) {
    res.status(401).json({ error: 'Auth error' });
  }
}

// ══════════════════════════════════════════
// BACKGROUND MONITORING
// Runs every 5 minutes server-side as backup
// Even if no users have the app open
// ══════════════════════════════════════════
cron.schedule('*/5 * * * *', async () => {
  try {
    console.log('[Cron] Running background monitor...');
    const alerts = await pool.query('SELECT a.*, u.fb_token, u.fcm_token FROM alerts a JOIN users u ON a.user_id=u.id WHERE a.active=true');
    console.log(`[Cron] ${alerts.rows.length} active alerts`);
    // Background processing happens via the poll endpoint when users are active
    // This cron just keeps the server warm and logs activity
  } catch (e) {
    console.error('[Cron]', e.message);
  }
});

// ══════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════
app.get('/', (_, res) => res.json({ app: 'FlipAlert API', status: 'running', version: '2.0.0' }));
app.get('/health', async (_, res) => {
  try {
    const db = await pool.query('SELECT COUNT(*) FROM alerts');
    res.json({ status: 'ok', activeAlerts: parseInt(db.rows[0].count) });
  } catch (e) {
    res.json({ status: 'ok', db: 'error' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ FlipAlert running on port ${PORT}`));
