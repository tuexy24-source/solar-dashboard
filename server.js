const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appKbfE8na15iM6EZ';
const AIRTABLE_TABLE_NAME = 'Outbound Leads';
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;
const AIRTABLE_HEADERS = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const AGENT_NAMES = {
  'agent_1e091e25b84ea5d6b51088aaed': 'Rebate Program',
  'agent_458529f65d305930d071f2a93e': 'Reduced Energy'
};

// ── Recording duration cache (probed from WAV headers) ──────────────────────
const durationCache = new Map(); // url -> seconds

async function probeWavDuration(url) {
  if (!url) return 0;
  if (durationCache.has(url)) return durationCache.get(url);
  try {
    const resp = await fetch(url, { method: 'HEAD', timeout: 5000 });
    if (!resp.ok) return 0;
    const len = parseInt(resp.headers.get('content-length') || '0');
    if (len <= 44) return 0;
    // WAV: 24kHz mono 16-bit PCM = 48000 bytes/sec (confirmed from file headers)
    const dur = Math.round((len - 44) / 48000);
    durationCache.set(url, dur);
    return dur;
  } catch { return 0; }
}

async function probeAllDurations(records) {
  const toProbe = records.filter(r => r.recordingUrl && !r.callDuration && !durationCache.has(r.recordingUrl));
  if (!toProbe.length) return;
  console.log(`[${new Date().toISOString()}] Probing ${toProbe.length} recording durations...`);
  await Promise.all(toProbe.map(r => probeWavDuration(r.recordingUrl)));
  console.log(`[${new Date().toISOString()}] Probed ${toProbe.length} durations, cache size: ${durationCache.size}`);
}

// ── Cache ───────────────────────────────────────────────────────────────────
let cache = { records: null, raw: null, ts: 0 };
const CACHE_TTL = 20_000;

async function fetchAllRecords() {
  const now = Date.now();
  if (cache.records && now - cache.ts < CACHE_TTL) return cache.records;

  let allRecords = [];
  let offset = null;
  do {
    const params = new URLSearchParams({
      pageSize: '100',
      'sort[0][field]': 'Last Call Date',
      'sort[0][direction]': 'desc'
    });
    if (offset) params.set('offset', offset);
    const url = `${AIRTABLE_URL}?${params}`;
    console.log(`[${new Date().toISOString()}] Fetching from Airtable...`);
    const res = await fetch(url, { headers: AIRTABLE_HEADERS });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
    const data = await res.json();
    allRecords = allRecords.concat(data.records);
    offset = data.offset || null;
  } while (offset);

  const mapped = allRecords.map(r => {
    const f = r.fields;
    return {
      id: r.id,
      firstName: f['First Name'] || '',
      lastName: f['Last Name'] || '',
      phone: f['Phone'] || '',
      email: f['Email'] || '',
      address: f['Address'] || '',
      city: f['City'] || '',
      state: f['State'] || '',
      zip: f['Zip'] || '',
      status: f['Status'] || '',
      callOutcome: f['Call Outcome'] || '',
      lastCallDate: f['Last Call Date'] || '',
      // FIXED: actual Airtable field names
      recordingUrl: f['Latest Recording'] || f['Recording URLs'] || '',
      transcript: f['Transcript'] || '',
      notes: f['Notes'] || '',
      callDuration: f['Call Duration'] || 0,
      attemptCount: f['Attempt Count'] || 0,
      electricBill: f['Electric Bill'] || '',
      roofAge: f['Roof Age (Years)'] ?? '',
      utilityCompany: f['Utility Company'] || '',
      calendarLink: f['Calendar Link'] || '',
      calculatedDate: f['Calculated Date'] || '',
      retellCallId: f['Retell Call ID'] || '',
      agentId: f['Agent ID'] || '',
      agentName: AGENT_NAMES[f['Agent ID']] || f['Agent ID'] || 'Unknown',
      createdDate: f['Created Date'] || '',
      lastModified: f['Last Modified'] || '',
      daysSinceContact: f['Days Since Contact'] ?? '',
      source: f['Source'] || '',
      rep: f['Rep'] || '',
      fields: f
    };
  });

  // Probe recording durations for records missing callDuration
  await probeAllDurations(mapped);
  // Attach probed duration to each record
  for (const r of mapped) {
    r.probedDuration = r.callDuration || durationCache.get(r.recordingUrl) || 0;
  }

  const prev = cache.records;
  cache = { records: mapped, raw: allRecords, ts: now };
  console.log(`[${new Date().toISOString()}] Cached ${mapped.length} records`);

  if (prev) detectChanges(prev, mapped);
  return mapped;
}

// ── SSE ─────────────────────────────────────────────────────────────────────
const sseClients = new Set();

function detectChanges(oldRecs, newRecs) {
  const oldMap = new Map(oldRecs.map(r => [r.id, r]));
  for (const nr of newRecs) {
    const or = oldMap.get(nr.id);
    if (!or) {
      broadcast({ type: 'new_lead', data: { name: nr.firstName + ' ' + nr.lastName } });
    } else if (or.status !== nr.status) {
      broadcast({ type: 'status_change', data: { name: nr.firstName + ' ' + nr.lastName, oldStatus: or.status, newStatus: nr.status } });
      if (nr.status === 'Booked' && or.status !== 'Booked') {
        broadcast({ type: 'appointment_booked', data: { name: nr.firstName + ' ' + nr.lastName } });
      }
    } else if (or.lastCallDate !== nr.lastCallDate) {
      broadcast({ type: 'new_call', data: { name: nr.firstName + ' ' + nr.lastName, outcome: nr.callOutcome } });
    }
  }
}

function broadcast(event) {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) client.write(msg);
}

setInterval(async () => {
  try { cache.ts = 0; await fetchAllRecords(); }
  catch (e) { console.error('Background poll error:', e.message); }
}, 30_000);

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
// No-cache for HTML so browser always gets latest
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ── SSE endpoint ────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Leads list ──────────────────────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  try {
    const all = await fetchAllRecords();
    const { search, status, outcome, dateFrom, dateTo, page = 1, limit = 20, sort = 'lastCallDate', dir = 'desc' } = req.query;

    let filtered = [...all];
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(r =>
        `${r.firstName} ${r.lastName}`.toLowerCase().includes(q) ||
        r.phone.includes(q) || r.address.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)
      );
    }
    if (status) { const ss = status.split(','); filtered = filtered.filter(r => ss.includes(r.status)); }
    if (outcome) { const oo = outcome.split(','); filtered = filtered.filter(r => oo.includes(r.callOutcome)); }
    if (req.query.agent) { const aa = req.query.agent.split(','); filtered = filtered.filter(r => aa.includes(r.agentId) || aa.includes(r.agentName)); }
    if (dateFrom) filtered = filtered.filter(r => r.lastCallDate >= dateFrom);
    if (dateTo) filtered = filtered.filter(r => r.lastCallDate <= dateTo + 'T23:59:59');
    if (req.query.minDuration) { const md = parseInt(req.query.minDuration); filtered = filtered.filter(r => r.probedDuration >= md); }

    const sortKey = sort;
    filtered.sort((a, b) => {
      let av = a[sortKey] ?? '', bv = b[sortKey] ?? '';
      if (typeof av === 'number' && typeof bv === 'number') return dir === 'asc' ? av - bv : bv - av;
      av = String(av); bv = String(bv);
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });

    const total = filtered.length;
    const p = Math.max(1, parseInt(page));
    const l = Math.max(1, Math.min(100, parseInt(limit)));
    const pages = Math.ceil(total / l);
    const paged = filtered.slice((p - 1) * l, p * l);

    // Stats
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const bookedToday = all.filter(r => r.status === 'Booked' && r.lastCallDate.startsWith(today)).length;
    const bookedYesterday = all.filter(r => r.status === 'Booked' && r.lastCallDate.startsWith(yesterday)).length;
    const readyToCall = all.filter(r => r.status === 'Ready to Call').length;
    const needsRetry = all.filter(r => r.status === 'Needs Retry').length;
    const callbacksScheduled = all.filter(r => r.status === 'Callback Requested').length;
    const currentlyCalling = all.filter(r => r.status === 'Currently Calling').length;
    const totalCallsToday = all.filter(r => r.lastCallDate && r.lastCallDate.startsWith(today)).length;
    const totalCallsYesterday = all.filter(r => r.lastCallDate && r.lastCallDate.startsWith(yesterday)).length;
    const totalContacted = all.filter(r => r.lastCallDate).length;
    const totalBooked = all.filter(r => r.status === 'Booked').length;
    const conversionRate = totalContacted > 0 ? ((totalBooked / totalContacted) * 100).toFixed(1) : '0.0';

    // Average call duration (using probed duration when available)
    const durations = all.filter(r => r.probedDuration > 0).map(r => r.probedDuration);
    const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

    // Avg attempts to book
    const bookedLeads = all.filter(r => r.status === 'Booked' && r.attemptCount > 0);
    const avgAttemptsToBook = bookedLeads.length > 0 ? (bookedLeads.reduce((a, r) => a + r.attemptCount, 0) / bookedLeads.length).toFixed(1) : '—';

    // 7-day trends
    const trends = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
      trends[d] = { calls: 0, booked: 0 };
    }
    for (const r of all) {
      if (!r.lastCallDate) continue;
      const d = r.lastCallDate.split('T')[0];
      if (trends[d]) { trends[d].calls++; if (r.status === 'Booked') trends[d].booked++; }
    }
    const trendDays = Object.keys(trends).sort();

    // Filter options
    const allStatuses = [...new Set(all.map(r => r.status).filter(Boolean))].sort();
    const allOutcomes = [...new Set(all.map(r => r.callOutcome).filter(Boolean))].sort();
    const allAgents = [...new Set(all.map(r => r.agentName).filter(s => s && s !== 'Unknown'))].sort();

    res.json({
      stats: {
        bookedToday, bookedYesterday, readyToCall, needsRetry, callbacksScheduled,
        currentlyCalling, totalCallsToday, totalCallsYesterday, conversionRate,
        totalBooked, totalContacted, avgDuration, avgAttemptsToBook,
        callsTrend: trendDays.map(d => trends[d].calls),
        bookedTrend: trendDays.map(d => trends[d].booked),
        trendDays
      },
      records: paged,
      pagination: { page: p, limit: l, total, pages },
      filters: { statuses: allStatuses, outcomes: allOutcomes, agents: allAgents },
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error in /api/leads:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ── Single lead ─────────────────────────────────────────────────────────────
app.get('/api/leads/:id', async (req, res) => {
  try {
    const all = await fetchAllRecords();
    const lead = all.find(r => r.id === req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── Update lead ─────────────────────────────────────────────────────────────
app.patch('/api/leads/:id', async (req, res) => {
  try {
    const { fields } = req.body;
    if (!fields) return res.status(400).json({ error: 'Missing fields' });
    console.log(`[PATCH] ${req.params.id} fields:`, JSON.stringify(fields));
    const resp = await fetch(`${AIRTABLE_URL}/${req.params.id}`, {
      method: 'PATCH', headers: AIRTABLE_HEADERS, body: JSON.stringify({ fields })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[PATCH] Airtable error ${resp.status}:`, errText);
      return res.status(resp.status).json({ error: 'Airtable update failed', details: errText });
    }
    cache.ts = 0;
    res.json({ success: true, record: await resp.json() });
  } catch (err) {
    console.error('[PATCH] Server error:', err.message);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ── Delete Lead ───────────────────────────────────────────────────────────────
app.delete('/api/leads/:id', async (req, res) => {
  try {
    const resp = await fetch(`${AIRTABLE_URL}/${req.params.id}`, {
      method: 'DELETE',
      headers: AIRTABLE_HEADERS
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: 'Airtable delete failed', details: errText });
    }
    cache.ts = 0;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ── Delete Recording ─────────────────────────────────────────────────────────
app.delete('/api/leads/:id/recording', async (req, res) => {
  try {
    const resp = await fetch(`${AIRTABLE_URL}/${req.params.id}`, {
      method: 'PATCH',
      headers: AIRTABLE_HEADERS,
      body: JSON.stringify({ fields: { 'Recording URLs': '' } })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: 'Airtable update failed', details: errText });
    }
    cache.ts = 0;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ── Analytics ───────────────────────────────────────────────────────────────
app.get('/api/analytics', async (req, res) => {
  try {
    const all = await fetchAllRecords();

    const outcomeCounts = {};
    const hourly = new Array(24).fill(0);
    const durationBuckets = { '0-30s': 0, '30-60s': 0, '1-2m': 0, '2-5m': 0, '5-10m': 0, '10m+': 0 };

    for (const r of all) {
      outcomeCounts[r.callOutcome || 'No Outcome'] = (outcomeCounts[r.callOutcome || 'No Outcome'] || 0) + 1;
      if (r.lastCallDate) { const h = new Date(r.lastCallDate).getHours(); if (!isNaN(h)) hourly[h]++; }
      if (r.probedDuration > 0) {
        const d = r.probedDuration;
        if (d <= 30) durationBuckets['0-30s']++;
        else if (d <= 60) durationBuckets['30-60s']++;
        else if (d <= 120) durationBuckets['1-2m']++;
        else if (d <= 300) durationBuckets['2-5m']++;
        else if (d <= 600) durationBuckets['5-10m']++;
        else durationBuckets['10m+']++;
      }
    }

    const daily = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
      daily[d] = { calls: 0, booked: 0 };
    }
    for (const r of all) {
      if (!r.lastCallDate) continue;
      const d = r.lastCallDate.split('T')[0];
      if (daily[d]) { daily[d].calls++; if (r.status === 'Booked') daily[d].booked++; }
    }

    const statusCounts = {};
    for (const r of all) { statusCounts[r.status || 'Unknown'] = (statusCounts[r.status || 'Unknown'] || 0) + 1; }

    const agentBreakdown = {};
    for (const r of all) {
      const agent = r.agentName || 'Unknown';
      if (!agentBreakdown[agent]) agentBreakdown[agent] = { calls: 0, booked: 0, notInterested: 0, hungUp: 0, voicemail: 0, callback: 0, noAnswer: 0, renter: 0, durations: [] };
      agentBreakdown[agent].calls++;
      if (r.callOutcome === 'BOOKED') agentBreakdown[agent].booked++;
      if (r.callOutcome === 'NOT_INTERESTED') agentBreakdown[agent].notInterested++;
      if (r.callOutcome === 'HUNG_UP') agentBreakdown[agent].hungUp++;
      if (r.callOutcome === 'VOICEMAIL') agentBreakdown[agent].voicemail++;
      if (r.callOutcome === 'CALLBACK_REQUESTED') agentBreakdown[agent].callback++;
      if (r.callOutcome === 'NO_ANSWER') agentBreakdown[agent].noAnswer++;
      if (r.callOutcome === 'RENTER') agentBreakdown[agent].renter++;
      if (r.probedDuration > 0) agentBreakdown[agent].durations.push(r.probedDuration);
    }
    for (const a of Object.values(agentBreakdown)) {
      const contacted = a.calls - a.voicemail - a.noAnswer;
      a.contactRate = a.calls > 0 ? ((contacted / a.calls) * 100).toFixed(1) : '0.0';
      a.bookRate = contacted > 0 ? ((a.booked / contacted) * 100).toFixed(1) : '0.0';
      a.avgDuration = a.durations.length ? Math.round(a.durations.reduce((x, y) => x + y, 0) / a.durations.length) : 0;
      delete a.durations;
    }

    let bestHour = 0;
    for (let i = 1; i < 24; i++) if (hourly[i] > hourly[bestHour]) bestHour = i;

    const durations = all.filter(r => r.probedDuration > 0).map(r => r.probedDuration);
    const avgDuration = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

    res.json({ outcomeCounts, hourly, daily, statusCounts, durationBuckets, bestHour, totalRecords: all.length, avgDuration, agentBreakdown });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── CSV export ──────────────────────────────────────────────────────────────
app.get('/api/export/csv', async (req, res) => {
  try {
    const all = await fetchAllRecords();
    const headers = ['First Name','Last Name','Phone','Email','Status','Call Outcome','Call Duration','Last Call Date','Address','City','State','Electric Bill','Utility Company','Notes'];
    const esc = v => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [headers.join(',')];
    for (const r of all) {
      rows.push([r.firstName,r.lastName,r.phone,r.email,r.status,r.callOutcome,r.callDuration,r.lastCallDate,r.address,r.city,r.state,r.electricBill,r.utilityCompany,r.notes].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=solar-leads-${new Date().toISOString().split('T')[0]}.csv`);
    res.send(rows.join('\n'));
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
});

// ── Download proxy (for mobile) ──────────────────────────────────────────────
app.get('/api/download', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url || !url.startsWith('https://')) return res.status(400).json({ error: 'Invalid URL' });
    const name = req.query.name || 'recording.wav';
    const resp = await fetch(url);
    if (!resp.ok) return res.status(resp.status).json({ error: 'Download failed' });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    const cl = resp.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    resp.body.pipe(res);
  } catch (err) {
    console.error('Download proxy error:', err.message);
    res.status(500).json({ error: 'Download failed' });
  }
});

// ── Call Analysis ─────────────────────────────────────────────────────────────
const analysisCache = new Map();

app.get('/api/call-analysis', async (req, res) => {
  try {
    const targetDate = req.query.date || new Date().toISOString().split('T')[0];
    const all = await fetchAllRecords();
    const dayRecords = all.filter(r => r.lastCallDate && r.lastCallDate.startsWith(targetDate));
    const total = dayRecords.length;

    if (total === 0) {
      return res.json({ date: targetDate, metrics: null, aiAnalysis: null, hasAIKey: !!ANTHROPIC_API_KEY });
    }

    const outcomes = {};
    const durations = [];
    const objectionMap = {};
    let withTranscripts = 0;

    for (const r of dayRecords) {
      const o = r.callOutcome || 'UNKNOWN';
      outcomes[o] = (outcomes[o] || 0) + 1;
      const dur = r.probedDuration || r.callDuration || 0;
      if (dur > 0) durations.push(dur);
      if (r.transcript && r.transcript.length > 50) {
        withTranscripts++;
        const t = r.transcript.toLowerCase();
        const pats = [
          [/not interested/i, 'Not interested'], [/already have solar|got solar/i, 'Already has solar'],
          [/too busy|bad time/i, 'Too busy'], [/think about it|need to think/i, 'Need to think'],
          [/can.t afford|too expensive/i, 'Cost concern'], [/rent|tenant|landlord/i, 'Renter'],
          [/scam|fraud|fake/i, 'Scam concern'], [/do not call|stop calling/i, 'DNC request'],
          [/husband|wife|spouse/i, 'Need spouse input'], [/credit.*(bad|low|poor)/i, 'Credit concerns'],
          [/roof.*(old|bad|replac)/i, 'Roof issues'],
        ];
        for (const [pat, label] of pats) { if (pat.test(t)) objectionMap[label] = (objectionMap[label] || 0) + 1; }
      }
    }

    const contacted = dayRecords.filter(r => r.callOutcome && !['NO_ANSWER', 'VOICEMAIL'].includes(r.callOutcome)).length;
    const booked = outcomes['BOOKED'] || 0;
    const metrics = {
      total, contacted,
      contactRate: total > 0 ? ((contacted / total) * 100).toFixed(1) : '0.0',
      booked,
      bookRate: contacted > 0 ? ((booked / contacted) * 100).toFixed(1) : '0.0',
      avgDuration: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      outcomes, withTranscripts,
      objections: Object.entries(objectionMap).sort((a, b) => b[1] - a[1]).slice(0, 10)
    };

    res.json({ date: targetDate, metrics, aiAnalysis: analysisCache.get(targetDate) || null, hasAIKey: !!ANTHROPIC_API_KEY });
  } catch (err) {
    console.error('Call analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/call-analysis/ai', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set. Run: export ANTHROPIC_API_KEY="sk-..."' });
    const targetDate = req.body.date || new Date().toISOString().split('T')[0];
    if (analysisCache.has(targetDate) && !req.body.force) return res.json({ analysis: analysisCache.get(targetDate), cached: true });

    const all = await fetchAllRecords();
    const dayRecords = all.filter(r =>
      r.lastCallDate && r.lastCallDate.startsWith(targetDate) &&
      r.transcript && r.transcript.length > 100 &&
      (r.probedDuration || r.callDuration || 0) >= 30
    );
    if (!dayRecords.length) return res.status(400).json({ error: 'No substantial calls with transcripts for ' + targetDate });

    // Smart sampling: all BOOKED + up to 5 per other outcome, max 50
    const byOutcome = {};
    for (const r of dayRecords) { const o = r.callOutcome || 'UNKNOWN'; if (!byOutcome[o]) byOutcome[o] = []; byOutcome[o].push(r); }
    const sampled = [];
    if (byOutcome['BOOKED']) sampled.push(...byOutcome['BOOKED']);
    for (const [o, recs] of Object.entries(byOutcome)) { if (o !== 'BOOKED') sampled.push(...recs.slice(0, 5)); }
    const finalSample = sampled.slice(0, 50);

    let transcriptText = '';
    for (const r of finalSample) {
      const name = [r.firstName, r.lastName].filter(Boolean).join(' ') || 'Unknown';
      transcriptText += `\n### ${r.callOutcome || 'UNKNOWN'} - ${name} [${r.agentName || 'Unknown Agent'}] (${Math.round(r.probedDuration || r.callDuration || 0)}s)\n${r.transcript.substring(0, 1500)}\n`;
    }

    const allDay = all.filter(r => r.lastCallDate && r.lastCallDate.startsWith(targetDate));
    const total = allDay.length;
    const contacted = allDay.filter(r => r.callOutcome && !['NO_ANSWER', 'VOICEMAIL'].includes(r.callOutcome)).length;
    const bookedN = allDay.filter(r => r.callOutcome === 'BOOKED').length;
    const ocs = {}; for (const r of allDay) ocs[r.callOutcome || 'UNKNOWN'] = (ocs[r.callOutcome || 'UNKNOWN'] || 0) + 1;

    const prompt = `You are an expert solar sales call analyst. These are AI-powered outbound appointment-setting calls for solar energy consultations. Analyze them and provide specific, actionable insights.

# PERFORMANCE (${targetDate})
- Total Calls: ${total} | Contact Rate: ${total > 0 ? ((contacted/total)*100).toFixed(1) : 0}% | Booked: ${bookedN} (${contacted > 0 ? ((bookedN/contacted)*100).toFixed(1) : 0}%)
- Outcomes: ${JSON.stringify(ocs)}

# TRANSCRIPTS (${finalSample.length} sampled)
${transcriptText}

Analyze in these sections. Quote exact phrases from the transcripts.

## Conversion Killers
Top 3 things killing conversions:
- Quote the problematic phrase
- Why it hurts
- Exact replacement wording

## What's Working
2-3 effective techniques from successful calls:
- Quote the effective phrases
- Why they work

## Objection Handling
Objections not handled well with specific rebuttals for each.

## Script Fixes
Top 5 exact changes. For each:

**Fix: [section]**
- Current: "exact wording"
- Change to: "new wording"
- Why: reason

## Agent Performance
- Script adherence
- Natural conversation vs robotic
- Objection persistence (trying 3+ times?)
- Information collection quality
- Closing technique

## Action Items
Top 3-5 priorities before next session.

Be direct and specific. No generic advice.`;

    console.log(`[AI] Analyzing ${finalSample.length} calls for ${targetDate}...`);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] })
    });
    if (!response.ok) { const errBody = await response.text(); console.error('Anthropic error:', response.status, errBody); let errMsg=''; try{errMsg=JSON.parse(errBody)?.error?.message||errBody}catch{errMsg=errBody}; const friendly=errMsg.toLowerCase().includes('credit')||errMsg.toLowerCase().includes('balance')?'Insufficient API credits — add credits at console.anthropic.com/settings/billing':`AI failed (${response.status}): ${errMsg.slice(0,150)}`; return res.status(502).json({ error: friendly }); }

    const data = await response.json();
    const analysis = data.content[0].text;
    analysisCache.set(targetDate, analysis);
    console.log(`[AI] Done for ${targetDate}`);
    res.json({ analysis, cached: false, sampledCalls: finalSample.length, totalWithTranscripts: dayRecords.length });
  } catch (err) { console.error('AI error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Solar Dashboard running on port ${PORT}`);
  fetchAllRecords().catch(e => console.error('Warm-up failed:', e.message));
});
