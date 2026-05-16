/**
 * Crimson Isles — Discord Forum Sync
 * Salvează datele direct în repo (data/profiles.json)
 * accesibil via raw.githubusercontent.com (CORS activ)
 *
 * Variabile de mediu necesare în GitHub Secrets:
 *   DISCORD_TOKEN   — tokenul tău de utilizator Discord
 *   GITHUB_TOKEN    — ${{ secrets.GITHUB_TOKEN }} (automat în Actions)
 *   GITHUB_REPO     — "Xagun94/crimson-isles-km"
 *   GUILD_ID        — ID-ul serverului Discord
 *   CHANNEL_IDS     — ID-uri canale separate prin virgulă
 */

const https = require('https');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO;
const GUILD_ID      = process.env.GUILD_ID || '';
const CHANNEL_IDS   = (process.env.CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const DELAY_THREADS  = 400;
const DELAY_CHANNELS = 1000;

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 429) {
          const wait = parseInt(res.headers['retry-after'] || '5', 10) * 1000;
          console.log(`  [Rate limit] Astept ${wait}ms...`);
          setTimeout(() => request(options, body).then(resolve).catch(reject), wait);
          return;
        }
        try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }); }
        catch(e) { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function discordGet(path) {
  return request({
    hostname: 'discord.com',
    path: `/api/v10${path}`,
    method: 'GET',
    headers: { 'Authorization': DISCORD_TOKEN, 'Content-Type': 'application/json' }
  });
}

function githubRequest(method, path, body) {
  return request({
    hostname: 'api.github.com',
    path,
    method,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'CrimsonIsles-KM-Sync/1.0',
      'Content-Type': 'application/json'
    }
  }, body);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getAllThreads(channelId) {
  const threads = [], seen = new Set();
  let before = null, hasMore = true;
  while (hasMore) {
    const qs = `?limit=100${before ? `&before=${before}` : ''}`;
    const res = await discordGet(`/channels/${channelId}/threads/archived/public${qs}`);
    await sleep(300);
    if (res.status !== 200) break;
    const batch = res.body.threads || [];
    batch.forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); threads.push(t); } });
    hasMore = res.body.has_more === true;
    before = batch.length ? batch[batch.length - 1].thread_metadata?.archive_timestamp : null;
    if (!before) hasMore = false;
  }
  if (GUILD_ID) {
    const res = await discordGet(`/guilds/${GUILD_ID}/threads/active`);
    await sleep(300);
    if (res.status === 200) {
      (res.body.threads || [])
        .filter(t => t.parent_id === channelId)
        .forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); threads.push(t); } });
    }
  }
  return threads;
}

async function getThreadMessages(threadId) {
  const messages = [];
  let before = null, hasMore = true;
  while (hasMore) {
    const qs = `?limit=100${before ? `&before=${before}` : ''}`;
    const res = await discordGet(`/channels/${threadId}/messages${qs}`);
    await sleep(200);
    if (res.status !== 200) break;
    const batch = Array.isArray(res.body) ? res.body : [];
    if (!batch.length) break;
    messages.push(...batch);
    hasMore = batch.length === 100;
    before = batch[batch.length - 1].id;
  }
  return messages
    .filter(m => m.content?.trim())
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map(m => ({ author: m.author?.username || '', content: m.content, timestamp: m.timestamp }));
}

async function syncChannel(channelId, existingMap) {
  let channelName = channelId;
  const infoRes = await discordGet(`/channels/${channelId}`);
  if (infoRes.status === 200) channelName = infoRes.body.name || channelId;
  console.log(`\nCanal: #${channelName}`);
  const threads = await getAllThreads(channelId);
  console.log(`   Thread-uri: ${threads.length}`);
  const results = [];
  let newC = 0, updC = 0, skipC = 0;
  for (let i = 0; i < threads.length; i++) {
    const t = threads[i];
    const existing = existingMap[t.id];
    const lastMsgId = t.last_message_id || '';
    if (existing && existing._lastMsgId === lastMsgId && existing.combinedText) {
      results.push(existing); skipC++; continue;
    }
    console.log(`   (${i+1}/${threads.length}) ${existing ? 'UPDATE' : 'NEW'} ${t.name}`);
    const msgs = await getThreadMessages(t.id);
    results.push({
      threadId: t.id, threadName: t.name, channelId, channelName,
      _lastMsgId: lastMsgId, _syncedAt: new Date().toISOString(),
      combinedText: msgs.map(m => m.content).join('\n\n'),
      rawMessages: msgs
    });
    existing ? updC++ : newC++;
    await sleep(DELAY_THREADS);
  }
  console.log(`   OK: ${newC} noi, ${updC} actualizate, ${skipC} neschimbate`);
  return results;
}

async function getFileSha(repo, path) {
  const res = await githubRequest('GET', `/repos/${repo}/contents/${path}`);
  return res.status === 200 ? res.body.sha : null;
}

async function saveToRepo(repo, profiles) {
  const filePath = 'data/profiles.json';
  const content = JSON.stringify({ syncedAt: new Date().toISOString(), totalProfiles: profiles.length, profiles }, null, 2);
  const sha = await getFileSha(repo, filePath);
  const payload = {
    message: `sync: ${profiles.length} profile-uri [${new Date().toISOString()}]`,
    content: Buffer.from(content).toString('base64'),
    ...(sha ? { sha } : {})
  };
  const res = await githubRequest('PUT', `/repos/${repo}/contents/${filePath}`, payload);
  if (res.status !== 200 && res.status !== 201) throw new Error(`Eroare salvare: ${res.status}`);
  console.log(`\nSalvat: https://raw.githubusercontent.com/${repo}/main/${filePath}`);
}

async function main() {
  console.log('Crimson Isles Discord Sync —', new Date().toISOString());
  if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN lipsa!');
  if (!GITHUB_TOKEN)  throw new Error('GITHUB_TOKEN lipsa!');
  if (!GITHUB_REPO)   throw new Error('GITHUB_REPO lipsa!');
  if (!CHANNEL_IDS.length) throw new Error('CHANNEL_IDS lipsa!');

  const existingMap = {};
  try {
    const res = await githubRequest('GET', `/repos/${GITHUB_REPO}/contents/data/profiles.json`);
    if (res.status === 200 && res.body.content) {
      const parsed = JSON.parse(Buffer.from(res.body.content, 'base64').toString());
      (parsed.profiles || parsed).forEach(p => { if (p.threadId) existingMap[p.threadId] = p; });
      console.log(`Existente: ${Object.keys(existingMap).length}`);
    }
  } catch(e) { console.log('Prima rulare'); }

  const allProfiles = [];
  for (const channelId of CHANNEL_IDS) {
    try {
      allProfiles.push(...await syncChannel(channelId, existingMap));
    } catch(e) { console.error(`Eroare canal ${channelId}: ${e.message}`); }
    await sleep(DELAY_CHANNELS);
  }

  console.log(`\nTotal: ${allProfiles.length} profile-uri`);
  await saveToRepo(GITHUB_REPO, allProfiles);
  console.log('Sync complet!');
}

main().catch(e => { console.error('EROARE:', e.message); process.exit(1); });
