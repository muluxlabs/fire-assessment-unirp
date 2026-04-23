/**
 * ============================================================
 *  Bloomfield Innovations – UniRP
 *  FIRE Assessment + INDRIYA Smart Campus Audit
 *  Google Apps Script backend (single Web App)
 * ============================================================
 *
 *  HOW TO INSTALL
 *  ---------------------------------------------------------------
 *  1. Open your Google Sheet → Extensions → Apps Script.
 *  2. Replace the contents of Code.gs with this entire file.
 *  3. Project Settings → Script properties → add:
 *       SHEET_ID         = the ID of this Sheet (in its URL)
 *       DRIVE_FOLDER_ID  = the parent Drive folder for audit PDFs
 *       NOTIFY_EMAIL     = where to email each submission
 *                          (leave blank to email the script owner)
 *  4. Deploy → New deployment → type: Web app.
 *       Execute as:      Me
 *       Who has access:  Anyone
 *     Copy the /exec URL.  The current URL, hard-coded in both
 *     index.html and indriya.html, is:
 *       https://script.google.com/macros/s/AKfycby.../exec
 *     If you create a brand-new deployment, replace GS_URL in both
 *     HTML files. If you only "Manage deployments → edit → new
 *     version", the URL stays the same — no client change needed.
 *
 *  ROUTING CONTRACT
 *  ---------------------------------------------------------------
 *  All submissions are JSON POSTs to the /exec URL with a `type`
 *  key. This file routes by `type`:
 *
 *    { type: 'FIRE', ... }              -> "FIRE Responses" tab
 *    { type: 'INDRIYA_INTEREST', ... }  -> "INDRIYA Leads" tab
 *    { type: 'INDRIYA_AUDIT', ... }     -> "INDRIYA Responses" tab
 *                                          + PDF saved to Drive
 *
 *  No submission ever triggers a tab it wasn't meant for.
 * ============================================================
 */

// ──────────────────────────────────────────────────────────────
//  Tab names
// ──────────────────────────────────────────────────────────────
const TAB_FIRE              = 'FIRE Responses';
const TAB_INDRIYA_LEADS     = 'INDRIYA Leads';
const TAB_INDRIYA_RESPONSES = 'INDRIYA Responses';

// ──────────────────────────────────────────────────────────────
//  HTTP entry points
// ──────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    const body = parseBody(e);
    const type = String(body.type || 'FIRE').toUpperCase();

    if (type === 'FIRE')              return handleFire(body);
    if (type === 'INDRIYA_INTEREST')  return handleIndriyaLead(body);
    if (type === 'INDRIYA_AUDIT')     return handleIndriyaAudit(body);

    return json({ ok: false, error: 'Unknown type: ' + type });
  } catch (err) {
    logError_(err);
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return HtmlService.createHtmlOutput(
    '<p style="font-family:system-ui">FIRE + INDRIYA endpoint is live. Submit via POST.</p>'
  );
}

// ──────────────────────────────────────────────────────────────
//  Handlers
// ──────────────────────────────────────────────────────────────
function handleFire(p) {
  const headers = [
    'Timestamp','First Name','Last Name','Email','Phone','Role','Department',
    'Institution','Type','Students','Faculty','Programs','City','Current ERP',
    'FIRE Index','Category','Raw /125',
    'F (Functional)','I (Information)','R (Automation)','E (Economic)','S (Strategic)',
    'Goals'
  ];
  const row = [
    nowIso_(p.timestamp),
    p.firstName, p.lastName, p.email, p.phone, p.role, p.department,
    p.institutionName, p.institutionType, p.studentCount, p.faculty, p.programs,
    p.city, p.currentERP,
    num_(p.fireIndex), p.category, num_(p.totalRaw),
    num_(p.pillarF), num_(p.pillarI), num_(p.pillarR), num_(p.pillarE), num_(p.pillarS),
    p.goals
  ];
  appendRow_(TAB_FIRE, headers, row);

  sendNotify_(
    '🔥 FIRE Assessment – ' + (p.institutionName || 'Unknown') +
    ' · ' + (p.fireIndex != null ? p.fireIndex + '/100' : 'no-score') +
    ' (' + (p.category || '—') + ')',
    buildFireEmail_(p)
  );
  return json({ ok: true, type: 'FIRE' });
}

function handleIndriyaLead(p) {
  const headers = [
    'Timestamp','Name','Email','Phone','Institution','Goals','Source'
  ];
  const row = [
    nowIso_(p.timestamp),
    p.name, p.email, p.phone,
    p.institution, p.goals,
    p.source || 'FIRE Results page'
  ];
  appendRow_(TAB_INDRIYA_LEADS, headers, row);

  sendNotify_(
    '✨ INDRIYA lead – ' + (p.institution || p.name || 'Unknown'),
    buildIndriyaLeadEmail_(p)
  );
  return json({ ok: true, type: 'INDRIYA_INTEREST' });
}

function handleIndriyaAudit(p) {
  const ctx    = p.context || {};
  const scores = p.scores  || {};
  const byDim  = scores.byDim || {};
  const premium = p.premium_requested === true || p.premium_requested === 'yes';

  // Save PDF to Drive (per-institution sub-folder, de-duplicated by name)
  let pdfUrl = '';
  let pdfName = '';
  if (p.pdf_base64) {
    const saved = savePdfToDrive_(p.pdf_base64, ctx.institution, ctx.audName);
    pdfUrl  = saved.url;
    pdfName = saved.name;
  }

  const headers = [
    'Timestamp','Institution','Type','City','Students','Programs',
    'Auditor','Role','Email','Phone','Focus',
    'D1 Infrastructure (/20)','D2 Experience (/20)','D3 Automation (/20)',
    'D4 Data (/20)','D5 Innovation (/20)','D6 Sustainability (/20)',
    'Total','Max','Completion',
    'Premium Requested','PDF Name','PDF Link'
  ];
  const completion = premium ? 'Full (6 dimensions)' : 'Free tier (4 dimensions)';
  const row = [
    nowIso_(p.timestamp),
    ctx.institution, ctx.iType, ctx.city, ctx.students, ctx.programs,
    ctx.audName, ctx.audRole, ctx.audEmail, ctx.audPhone, ctx.audContext,
    num_(byDim.I), num_(byDim.E), num_(byDim.A), num_(byDim.D),
    num_(byDim.R), num_(byDim.S),
    num_(scores.total), num_(scores.max), completion,
    premium ? 'YES' : 'no',
    pdfName, pdfUrl
  ];
  appendRow_(TAB_INDRIYA_RESPONSES, headers, row);

  sendNotify_(
    '✨ INDRIYA Audit – ' + (ctx.institution || 'Unknown') +
    ' · ' + (scores.total != null ? scores.total + '/' + (scores.max||120) : 'no-score') +
    (premium ? ' · PREMIUM REQUESTED' : ' · free tier'),
    buildIndriyaAuditEmail_(p, pdfUrl, completion)
  );
  return json({ ok: true, type: 'INDRIYA_AUDIT', pdfUrl: pdfUrl });
}

// ──────────────────────────────────────────────────────────────
//  Drive: save audit PDF
// ──────────────────────────────────────────────────────────────
function savePdfToDrive_(base64, institution, auditor) {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty('DRIVE_FOLDER_ID');
  if (!folderId) throw new Error('DRIVE_FOLDER_ID script property is not set.');

  const parent = DriveApp.getFolderById(folderId);
  const safeInst = sanitizeFolderName_(institution || 'Unknown Institution');
  let instFolder;
  const it = parent.getFoldersByName(safeInst);
  if (it.hasNext()) instFolder = it.next();
  else              instFolder = parent.createFolder(safeInst);

  // Clean base64 (may be prefixed with data URL)
  const clean = String(base64).replace(/^data:application\/pdf;base64,/, '');
  const bytes = Utilities.base64Decode(clean);

  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Kolkata', 'yyyyMMdd_HHmmss');
  const auditorTag = auditor ? ('_' + sanitizeFolderName_(auditor).replace(/\s+/g,'-')) : '';
  const name  = 'INDRIYA_' + safeInst.replace(/\s+/g,'-') + auditorTag + '_' + stamp + '.pdf';

  const blob = Utilities.newBlob(bytes, 'application/pdf', name);
  const file = instFolder.createFile(blob);
  file.setDescription('INDRIYA Smart Campus Audit · ' + (institution||'') +
                      (auditor ? ' · auditor: ' + auditor : '') +
                      ' · generated ' + new Date().toISOString());
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(_) {}
  return { url: file.getUrl(), name: name };
}

function sanitizeFolderName_(s) {
  return String(s || '').replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().substring(0, 120) || 'Unknown';
}

// ──────────────────────────────────────────────────────────────
//  Email bodies
// ──────────────────────────────────────────────────────────────
function buildFireEmail_(p) {
  const L = [];
  L.push('New FIRE Assessment Completed');
  L.push('─────────────────────────────────────────');
  L.push('RESPONDENT');
  L.push('   Name:        ' + compact_(p.firstName, p.lastName));
  L.push('   Role:        ' + fallback_(p.role));
  L.push('   Email:       ' + fallback_(p.email));
  L.push('   Phone:       ' + fallback_(p.phone));
  L.push('');
  L.push('INSTITUTION');
  L.push('   Name:        ' + fallback_(p.institutionName));
  L.push('   Type:        ' + fallback_(p.institutionType));
  L.push('   Students:    ' + fallback_(p.studentCount));
  L.push('   Faculty:     ' + fallback_(p.faculty));
  L.push('   Programs:    ' + fallback_(p.programs));
  L.push('   City:        ' + fallback_(p.city));
  L.push('   Current ERP: ' + fallback_(p.currentERP));
  L.push('');
  L.push('─────────────────────────────────────────');
  L.push('🔥 FIRE SCORE');
  L.push('   Index:    ' + fallback_(p.fireIndex) + ' / 100');
  L.push('   Category: ' + fallback_(p.category));
  L.push('   Raw:      ' + fallback_(p.totalRaw) + ' / 125');
  L.push('');
  L.push('   Pillar Breakdown:');
  L.push('     ⚙️  F – Functional:   ' + fallback_(p.pillarF) + '/25');
  L.push('     📊  I – Information:  ' + fallback_(p.pillarI) + '/25');
  L.push('     🤖  R – Automation:   ' + fallback_(p.pillarR) + '/25');
  L.push('     💰  E – Economic:     ' + fallback_(p.pillarE) + '/25');
  L.push('     🎯  S – Strategic:    ' + fallback_(p.pillarS) + '/25');
  L.push('');
  L.push('─────────────────────────────────────────');
  L.push('GOALS:  ' + fallback_(p.goals, '(not provided)'));
  L.push('─────────────────────────────────────────');
  L.push('');
  L.push('View responses:');
  L.push(sheetUrl_());
  return L.join('\n');
}

function buildIndriyaLeadEmail_(p) {
  const L = [];
  L.push('New INDRIYA interest lead');
  L.push('─────────────────────────────────────────');
  L.push('   Name:        ' + fallback_(p.name));
  L.push('   Institution: ' + fallback_(p.institution));
  L.push('   Email:       ' + fallback_(p.email));
  L.push('   Phone:       ' + fallback_(p.phone));
  L.push('   Goals:       ' + fallback_(p.goals, '(not provided)'));
  L.push('   Source:      ' + fallback_(p.source, 'FIRE Results page'));
  L.push('─────────────────────────────────────────');
  L.push('');
  L.push('View responses:');
  L.push(sheetUrl_());
  return L.join('\n');
}

function buildIndriyaAuditEmail_(p, pdfUrl, completion) {
  const ctx    = p.context || {};
  const scores = p.scores  || {};
  const byDim  = scores.byDim || {};
  const premium = p.premium_requested === true || p.premium_requested === 'yes';

  const L = [];
  L.push('New INDRIYA Smart Campus Audit submitted');
  L.push('─────────────────────────────────────────');
  L.push('INSTITUTION');
  L.push('   Name:        ' + fallback_(ctx.institution));
  L.push('   Type:        ' + fallback_(ctx.iType));
  L.push('   City:        ' + fallback_(ctx.city));
  L.push('   Students:    ' + fallback_(ctx.students));
  L.push('   Programs:    ' + fallback_(ctx.programs));
  L.push('');
  L.push('AUDITOR');
  L.push('   Name:        ' + fallback_(ctx.audName));
  L.push('   Role:        ' + fallback_(ctx.audRole));
  L.push('   Email:       ' + fallback_(ctx.audEmail));
  L.push('   Phone:       ' + fallback_(ctx.audPhone));
  L.push('   Focus:       ' + fallback_(ctx.audContext, '(not provided)'));
  L.push('');
  L.push('─────────────────────────────────────────');
  L.push('✨ INDRIYA SCORE');
  L.push('   Total:    ' + fallback_(scores.total) + ' / ' + fallback_(scores.max, 120));
  L.push('   Scope:    ' + completion);
  L.push('');
  L.push('   Dimension Breakdown:');
  L.push('     1  Digital Infrastructure:   ' + dimLine_(byDim.I));
  L.push('     2  Student Experience:       ' + dimLine_(byDim.E));
  L.push('     3  Automation & RPA:         ' + dimLine_(byDim.A));
  L.push('     4  Data Intelligence:        ' + dimLine_(byDim.D));
  L.push('     5  Innovation & Industry:    ' + dimLine_(byDim.R));
  L.push('     6  Sustainability:           ' + dimLine_(byDim.S));
  L.push('');
  L.push('─────────────────────────────────────────');
  L.push('PREMIUM ASSESSMENT REQUESTED:  ' + (premium ? 'YES — please prioritise follow-up' : 'no'));
  L.push('─────────────────────────────────────────');
  L.push('');
  L.push('REPORT (PDF with photos embedded):');
  L.push(pdfUrl || '   (not generated)');
  L.push('');
  L.push('Responses sheet:');
  L.push(sheetUrl_());
  return L.join('\n');
}

function dimLine_(v) {
  if (v === null || v === undefined || v === '') return 'Locked';
  return v + '/20';
}

// ──────────────────────────────────────────────────────────────
//  Sheet helpers
// ──────────────────────────────────────────────────────────────
function appendRow_(name, headers, row) {
  const sh = getSheet_(name, headers);
  // If the stored header row has grown (old deployments), left-pad row
  const currentCols = sh.getLastColumn();
  while (row.length < currentCols) row.push('');
  sh.appendRow(row);
}

function getSheet_(name, headers) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SHEET_ID');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#044a3d').setFontColor('white');
    sh.autoResizeColumns(1, headers.length);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#044a3d').setFontColor('white');
  }
  return sh;
}

function sheetUrl_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SHEET_ID');
  if (id) return 'https://docs.google.com/spreadsheets/d/' + id;
  try { return SpreadsheetApp.getActiveSpreadsheet().getUrl(); } catch(_) { return ''; }
}

// ──────────────────────────────────────────────────────────────
//  Email helpers
// ──────────────────────────────────────────────────────────────
function sendNotify_(subject, body) {
  try {
    const props = PropertiesService.getScriptProperties();
    const to = props.getProperty('NOTIFY_EMAIL') || Session.getActiveUser().getEmail();
    if (!to) return;
    MailApp.sendEmail({ to: to, subject: subject, body: body });
  } catch (err) { logError_(err); }
}

// ──────────────────────────────────────────────────────────────
//  Utilities
// ──────────────────────────────────────────────────────────────
function parseBody(e) {
  if (!e) return {};
  if (e.postData && e.postData.contents) {
    try { return JSON.parse(e.postData.contents); } catch (_) { /* fall through */ }
  }
  return e.parameter || {};
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function fallback_(v, alt) {
  if (v === null || v === undefined) return alt != null ? alt : '—';
  const s = String(v).trim();
  return s.length ? s : (alt != null ? alt : '—');
}

function compact_(a, b) {
  const parts = [a, b].map(x => (x == null ? '' : String(x).trim())).filter(Boolean);
  return parts.length ? parts.join(' ') : '—';
}

function num_(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return isNaN(n) ? v : n;
}

function nowIso_(v) {
  if (v) return v;
  return new Date().toISOString();
}

function logError_(err) {
  try { console.error(err); } catch(_) {}
  try { Logger.log(err && err.stack || err); } catch(_) {}
}
