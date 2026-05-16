/**
 * Crimson Isles — Discord Forum Sync + GitHub Pages Deploy
 *
 * GitHub Secrets necesare:
 *   DISCORD_TOKEN  — tokenul de utilizator Discord
 *   GITHUB_TOKEN   — ${{ secrets.GITHUB_TOKEN }} (automat)
 *   GITHUB_REPO    — "Xagun94/crimson-isles-km"
 *   GUILD_ID       — ID server Discord
 *   CHANNEL_IDS    — ID-uri canale, separate prin virgulă
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO;
const GUILD_ID      = process.env.GUILD_ID || '';
const CHANNEL_IDS   = (process.env.CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DELAY_T = 400, DELAY_C = 1000;

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 429) {
          const wait = parseInt(res.headers['retry-after'] || '5', 10) * 1000;
          console.log(`  [Rate limit] ${wait}ms...`);
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

function discord(p) {
  return request({ hostname:'discord.com', path:`/api/v10${p}`, method:'GET',
    headers:{'Authorization':DISCORD_TOKEN,'Content-Type':'application/json'} });
}

function github(method, p, body) {
  return request({ hostname:'api.github.com', path:p, method,
    headers:{'Authorization':`Bearer ${GITHUB_TOKEN}`,'Accept':'application/vnd.github+json',
      'User-Agent':'CrimsonIsles-KM/1.0','Content-Type':'application/json'} }, body);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getAllThreads(channelId) {
  const threads = [], seen = new Set();
  let before = null, hasMore = true;
  while (hasMore) {
    const qs = `?limit=100${before ? `&before=${before}` : ''}`;
    const res = await discord(`/channels/${channelId}/threads/archived/public${qs}`);
    await sleep(300);
    if (res.status !== 200) break;
    const batch = res.body.threads || [];
    batch.forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); threads.push(t); } });
    hasMore = res.body.has_more === true;
    before = batch.length ? batch[batch.length-1].thread_metadata?.archive_timestamp : null;
    if (!before) hasMore = false;
  }
  if (GUILD_ID) {
    const res = await discord(`/guilds/${GUILD_ID}/threads/active`);
    await sleep(300);
    if (res.status === 200)
      (res.body.threads||[]).filter(t=>t.parent_id===channelId)
        .forEach(t=>{ if(!seen.has(t.id)){seen.add(t.id);threads.push(t);} });
  }
  return threads;
}

async function getMessages(threadId) {
  const msgs = []; let before = null, hasMore = true;
  while (hasMore) {
    const res = await discord(`/channels/${threadId}/messages?limit=100${before?`&before=${before}`:''}`);
    await sleep(200);
    if (res.status !== 200) break;
    const batch = Array.isArray(res.body) ? res.body : [];
    if (!batch.length) break;
    msgs.push(...batch); hasMore = batch.length === 100;
    before = batch[batch.length-1].id;
  }
  return msgs.filter(m=>m.content?.trim())
    .sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp))
    .map(m=>({author:m.author?.username||'',content:m.content,timestamp:m.timestamp}));
}

async function syncChannel(channelId, existingMap) {
  let channelName = channelId;
  const info = await discord(`/channels/${channelId}`);
  if (info.status === 200) channelName = info.body.name || channelId;
  console.log(`\n📂 #${channelName}`);
  const threads = await getAllThreads(channelId);
  console.log(`   ${threads.length} thread-uri`);
  const results = []; let nc=0,uc=0,sc=0;
  for (let i = 0; i < threads.length; i++) {
    const t = threads[i], ex = existingMap[t.id], lm = t.last_message_id||'';
    if (ex && ex._lastMsgId === lm && ex.combinedText) { results.push(ex); sc++; continue; }
    console.log(`   (${i+1}/${threads.length}) ${ex?'🔄':'🆕'} ${t.name}`);
    const msgs = await getMessages(t.id);
    results.push({ threadId:t.id, threadName:t.name, channelId, channelName,
      _lastMsgId:lm, _syncedAt:new Date().toISOString(),
      combinedText:msgs.map(m=>m.content).join('\n\n'), rawMessages:msgs });
    ex ? uc++ : nc++;
    await sleep(DELAY_T);
  }
  console.log(`   ✅ ${nc} noi, ${uc} actualizate, ${sc} neschimbate`);
  return results;
}

async function getFileSha(repo, filePath, branch='main') {
  const res = await github('GET', `/repos/${repo}/contents/${filePath}?ref=${branch}`);
  return res.status === 200 ? res.body.sha : null;
}

async function putFile(repo, filePath, content, msg, branch='main') {
  const sha = await getFileSha(repo, filePath, branch);
  const res = await github('PUT', `/repos/${repo}/contents/${filePath}`, {
    message: msg, branch,
    content: Buffer.from(content).toString('base64'),
    ...(sha ? { sha } : {})
  });
  if (res.status !== 200 && res.status !== 201)
    console.warn(`   Warn ${filePath} on ${branch}: HTTP ${res.status}`);
  else console.log(`   ✓ ${filePath} → ${branch}`);
}

async function ensureGhPages(repo) {
  const res = await github('GET', `/repos/${repo}/branches/gh-pages`);
  if (res.status === 200) return;
  console.log('   Creez branch gh-pages...');
  const main = await github('GET', `/repos/${repo}/git/refs/heads/main`);
  if (main.status !== 200) throw new Error('Branch main negasit');
  await github('POST', `/repos/${repo}/git/refs`,
    { ref:'refs/heads/gh-pages', sha:main.body.object.sha });
}

async function main() {
  console.log('🦖 Crimson Isles Sync —', new Date().toISOString());
  if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN lipsa');
  if (!GITHUB_TOKEN)  throw new Error('GITHUB_TOKEN lipsa');
  if (!GITHUB_REPO)   throw new Error('GITHUB_REPO lipsa');
  if (!CHANNEL_IDS.length) throw new Error('CHANNEL_IDS lipsa');

  // Citim profiluri existente
  const existingMap = {};
  try {
    const res = await github('GET', `/repos/${GITHUB_REPO}/contents/data/profiles.json`);
    if (res.status === 200 && res.body.content) {
      const parsed = JSON.parse(Buffer.from(res.body.content,'base64').toString());
      (parsed.profiles||parsed).forEach(p=>{ if(p.threadId) existingMap[p.threadId]=p; });
      console.log(`Existente: ${Object.keys(existingMap).length}`);
    }
  } catch(e) { console.log('Prima rulare'); }

  // Sync Discord
  const all = [];
  for (const ch of CHANNEL_IDS) {
    try { all.push(...await syncChannel(ch, existingMap)); }
    catch(e) { console.error(`Eroare ${ch}: ${e.message}`); }
    await sleep(DELAY_C);
  }
  console.log(`\n📊 Total: ${all.length} profile-uri`);

  const now = new Date().toISOString();
  const msg = `sync: ${all.length} profile-uri [${now}]`;

  // Slim (fără rawMessages)
  const slim = all.map(({rawMessages,...rest})=>rest);

  // Salvează pe main
  await putFile(GITHUB_REPO, 'data/profiles.json',
    JSON.stringify({syncedAt:now,totalProfiles:all.length,profiles:all},null,2), msg);
  await putFile(GITHUB_REPO, 'data/profiles-slim.json',
    JSON.stringify({syncedAt:now,totalProfiles:slim.length,profiles:slim},null,2), msg);

  // Deploy pe gh-pages
  console.log('\n📄 Deploy GitHub Pages...');
  await ensureGhPages(GITHUB_REPO);
  const slimJson = JSON.stringify({syncedAt:now,totalProfiles:slim.length,profiles:slim},null,2);
  await putFile(GITHUB_REPO, 'profiles-slim.json', slimJson, msg, 'gh-pages');

  // index.html e gestionat manual pe gh-pages — nu se suprascrie automat

  // Activează GitHub Pages dacă nu e activ
  const pages = await github('GET', `/repos/${GITHUB_REPO}/pages`);
  if (pages.status === 404) {
    await github('POST', `/repos/${GITHUB_REPO}/pages`, {source:{branch:'gh-pages',path:'/'}});
    console.log('   GitHub Pages activat');
  }

  // Procesare Claude — extrage date structurate
  console.log('\n🤖 Procesare Claude...');
  const processed = await processWithClaude(slim);
  console.log(`   ${processed.length} profile-uri procesate`);

  // Salvează processed profiles pe gh-pages
  if (processed.length > 0) {
    const procJson = JSON.stringify({ syncedAt: now, totalProfiles: processed.length, profiles: processed }, null, 2);
    await putFile(GITHUB_REPO, 'processed-profiles.json', procJson, msg, 'gh-pages');
  }

  const [owner, repoName] = GITHUB_REPO.split('/');
  console.log(`\n✨ Done! KM app: https://${owner.toLowerCase()}.github.io/${repoName}/`);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

// ── Claude processing (runs in GitHub Actions) ────────────────────────────────

async function processWithClaude(profiles) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) { console.warn('   ANTHROPIC_API_KEY lipsa — skip procesare'); return []; }

  const SYS = 'You are an assistant for a Path of Titans server. Extract information from a dinosaur profile and return ONLY valid JSON, no markdown, no backticks.\nExact structure:\n{"name":"string","tier":"string","slots":"string","combatWeight":"string","passiveGrowthTime":"string","lifestyle":"string","description":"string","groupLimit":["string"],"hunting":["string"],"scavenging":["string"],"cannibalism":"string","nesting":["string"],"specialRules":["string"],"rpNotes":["string"]}\nIf a field does not exist, use "" or []. tier = Apex/Sub-Apex/High/Mid/Low/Semi-Aquatic/Aquatic/Flying/Herbivore.';

  async function callClaude(name, text) {
    const res = await request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    }, JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: SYS,
      messages: [{ role: 'user', content: `Dinosaur: ${name}\n\nContent:\n${text.substring(0, 3000)}` }]
    }));
    if (res.status !== 200) throw new Error(`API ${res.status}`);
    const txt = (res.body.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    return JSON.parse(txt.replace(/```json|```/g, '').trim());
  }

  const processed = [];
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i];
    process.stdout.write(`   (${i+1}/${profiles.length}) ${p.threadName} ... `);
    try {
      const result = await callClaude(p.threadName, p.combinedText || '');
      result.threadId = p.threadId;
      result.channelId = p.channelId;
      result.channelName = p.channelName;
      processed.push(result);
      console.log('✓');
    } catch(e) {
      console.log(`✗ ${e.message}`);
      // Păstrăm profilul neprocesat cu datele de bază
      processed.push({ name: p.threadName, tier: '', threadId: p.threadId, channelId: p.channelId, channelName: p.channelName });
    }
    await sleep(300);
  }
  return processed;
}
