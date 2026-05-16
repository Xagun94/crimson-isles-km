/**
 * Crimson Isles — Discord Forum Sync
 * ====================================
 * Rulează automat pe GitHub Actions sau local.
 * Preia toate thread-urile din canalele configurate,
 * detectează modificările și actualizează GitHub Gist.
 *
 * Variabile de mediu necesare:
 *   DISCORD_TOKEN   — tokenul tău de utilizator Discord
 *   GITHUB_TOKEN    — token GitHub cu acces la Gist (scope: gist)
 *   GIST_ID         — ID-ul Gist-ului unde se salvează datele
 *   CHANNEL_IDS     — ID-uri canale separate prin virgulă
 *                     ex: "123456789,987654321,111222333,444555666"
 */

const https = require('https');

// ─── Configurare ────────────────────────────────────────────────────────────

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GIST_ID       = process.env.GIST_ID;
const CHANNEL_IDS   = (process.env.CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const GUILD_ID      = process.env.GUILD_ID || '';

// Pauze între request-uri (ms) — evită rate limiting
const DELAY_BETWEEN_THREADS  = 400;
const DELAY_BETWEEN_CHANNELS = 1000;

// ─── Utilitare HTTP ─────────────────────────────────────────────────────────

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 429) {
          // Rate limited — extrage Retry-After și re-încearcă
          const retryAfter = parseInt(res.headers['retry-after'] || '5', 10) * 1000;
          console.log(`  [Rate limit] Aștept ${retryAfter}ms...`);
          setTimeout(() => request(options, body).then(resolve).catch(reject), retryAfter);
          return;
        }
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
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

// ─── Discord: adună thread-uri dintr-un canal ────────────────────────────────

async function getChannelInfo(channelId) {
  const res = await discordGet(`/channels/${channelId}`);
  if (res.status !== 200) throw new Error(`Canal ${channelId} inaccesibil: ${res.status}`);
  return res.body;
}

async function getAllThreads(channelId) {
  const threads = [];
  const seen = new Set();

  // 1. Thread-uri arhivate (posts închise — profilurile sunt de obicei arhivate)
  let before = null;
  let hasMore = true;
  while (hasMore) {
    const qs = `?limit=100${before ? `&before=${before}` : ''}`;
    const res = await discordGet(`/channels/${channelId}/threads/archived/public${qs}`);
    await sleep(300);
    if (res.status !== 200) { console.warn(`  Arhivate: eroare ${res.status}`); break; }
    const batch = res.body.threads || [];
    batch.forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); threads.push(t); } });
    hasMore = res.body.has_more === true;
    if (batch.length > 0) before = batch[batch.length - 1].thread_metadata?.archive_timestamp;
    else hasMore = false;
  }

  // 2. Thread-uri active (posts deschise)
  if (GUILD_ID) {
    const res = await discordGet(`/guilds/${GUILD_ID}/threads/active`);
    await sleep(300);
    if (res.status === 200) {
      const active = (res.body.threads || []).filter(t => t.parent_id === channelId);
      active.forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); threads.push(t); } });
    }
  }

  return threads;
}

async function getThreadMessages(threadId) {
  const messages = [];
  let before = null;
  let hasMore = true;

  while (hasMore) {
    const qs = `?limit=100${before ? `&before=${before}` : ''}`;
    const res = await discordGet(`/channels/${threadId}/messages${qs}`);
    await sleep(200);
    if (res.status !== 200) break;
    const batch = Array.isArray(res.body) ? res.body : [];
    if (batch.length === 0) break;
    messages.push(...batch);
    hasMore = batch.length === 100;
    before = batch[batch.length - 1].id;
  }

  return messages
    .filter(m => m.content && m.content.trim().length > 0)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map(m => ({ author: m.author?.username || '', content: m.content, timestamp: m.timestamp }));
}

// ─── Sync logic cu detectare modificări ─────────────────────────────────────

async function syncChannel(channelId, existingProfiles) {
  let channelName = channelId;
  try {
    const info = await getChannelInfo(channelId);
    channelName = info.name || channelId;
    console.log(`\n📂 Canal: #${channelName} (${channelId})`);
  } catch(e) {
    console.warn(`  Nu am putut obține info canal: ${e.message}`);
  }

  const threads = await getAllThreads(channelId);
  console.log(`  Thread-uri găsite: ${threads.length}`);

  // Map existent după thread ID
  const existingMap = {};
  existingProfiles.forEach(p => { if (p.threadId) existingMap[p.threadId] = p; });

  const updated = [];
  let newCount = 0, changedCount = 0, skippedCount = 0;

  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    const existing = existingMap[thread.id];
    const lastMsgTs = thread.last_message_id || '';

    // Dacă thread-ul există și nu s-a modificat, skip
    if (existing && existing._lastMsgId === lastMsgTs && existing.combinedText) {
      updated.push(existing);
      skippedCount++;
      continue;
    }

    console.log(`  (${i+1}/${threads.length}) ${existing ? '🔄' : '🆕'} ${thread.name}`);
    const messages = await getThreadMessages(thread.id);
    const combinedText = messages.map(m => m.content).join('\n\n');

    updated.push({
      threadId: thread.id,
      threadName: thread.name,
      channelId,
      channelName,
      _lastMsgId: lastMsgTs,
      _syncedAt: new Date().toISOString(),
      combinedText,
      rawMessages: messages
    });

    if (existing) changedCount++; else newCount++;
    await sleep(DELAY_BETWEEN_THREADS);
  }

  console.log(`  ✅ ${newCount} noi, ${changedCount} actualizate, ${skippedCount} neschimbate`);
  return updated;
}

// ─── GitHub Gist ─────────────────────────────────────────────────────────────

async function readGist() {
  const res = await githubRequest('GET', `/gists/${GIST_ID}`);
  if (res.status !== 200) throw new Error(`Gist inaccesibil: ${res.status} — verifică GIST_ID și GITHUB_TOKEN`);
  const file = res.body.files?.['crimson_isles_profiles.json'];
  if (!file?.content) return [];
  try { return JSON.parse(file.content); } catch(e) { return []; }
}

async function writeGist(profiles) {
  const payload = {
    description: `Crimson Isles — Dino Profiles (actualizat ${new Date().toISOString()})`,
    files: {
      'crimson_isles_profiles.json': {
        content: JSON.stringify({ syncedAt: new Date().toISOString(), totalProfiles: profiles.length, profiles }, null, 2)
      }
    }
  };
  const res = await githubRequest('PATCH', `/gists/${GIST_ID}`, payload);
  if (res.status !== 200) throw new Error(`Eroare scriere Gist: ${res.status}`);
  console.log('\n💾 Gist actualizat cu succes!');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🦖 Crimson Isles Discord Sync');
  console.log(`   Canale: ${CHANNEL_IDS.length}`);
  console.log(`   Data: ${new Date().toISOString()}\n`);

  // Validare
  if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN lipsește!');
  if (!GITHUB_TOKEN)  throw new Error('GITHUB_TOKEN lipsește!');
  if (!GIST_ID)       throw new Error('GIST_ID lipsește!');
  if (!CHANNEL_IDS.length) throw new Error('CHANNEL_IDS lipsește!');

  // Citim profilurile existente din Gist
  console.log('📖 Citesc profiluri existente din Gist...');
  let existingData = [];
  try { existingData = await readGist(); } catch(e) { console.warn('  Gist gol sau nou:', e.message); }
  const existingProfiles = existingData.profiles || existingData;
  console.log(`   ${existingProfiles.length} profile-uri existente`);

  // Sincronizare canal cu canal
  const allProfiles = [];
  for (const channelId of CHANNEL_IDS) {
    try {
      const channelProfiles = await syncChannel(channelId, existingProfiles);
      allProfiles.push(...channelProfiles);
    } catch(e) {
      console.error(`  ❌ Eroare canal ${channelId}: ${e.message}`);
    }
    await sleep(DELAY_BETWEEN_CHANNELS);
  }

  console.log(`\n📊 Total profile-uri: ${allProfiles.length}`);

  // Salvăm în Gist
  await writeGist(allProfiles);
  console.log('\n✨ Sync complet!');
}

main().catch(e => { console.error('💥 Eroare fatală:', e.message); process.exit(1); });
