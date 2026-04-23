/**
 * ============================================================
 *  Bloomfield Innovations - UniRP
 *  FIRE Assessment + INDRIYA Smart Campus Audit
 *  Google Apps Script backend (single Web App)
 * ============================================================
 *
 *  INSTALL
 *  ---------------------------------------------------------------
 *  1. Open the bound Google Sheet > Extensions > Apps Script.
 *  2. Replace Code.gs with this entire file.
 *  3. Deploy > Manage deployments > Edit (pencil) > Version: New
 *     version > Deploy.
 *     The /exec URL stays the same, so no client change is needed.
 *  4. On first run the script will prompt you to authorise Sheets,
 *     Drive, and Gmail scopes. Approve all three.
 *
 *  ROUTING
 *  ---------------------------------------------------------------
 *  All submissions are JSON POSTs. Route by `type`:
 *
 *    { type: 'FIRE', ... }             -> "FIRE Responses" tab
 *    { type: 'INDRIYA_INTEREST', ... } -> "INDRIYA Registrations" tab
 *    { type: 'INDRIYA_AUDIT', ... }    -> "INDRIYA Responses" tab
 *                                         + PDF saved to Drive
 *
 *  (Absence of `type` is treated as FIRE, matching the old client.)
 * ============================================================
 */

// ============================================================
//  HARD-CODED IDS  (identical to the previous working FIRE script,
//  plus the new Drive folder for INDRIYA audit PDFs)
// ============================================================
const SHEET_ID        = '1YMjzF1SZ2UZElN573zlMn1AGOXTJ7usDxmHkE0-CVVE';
const DRIVE_FOLDER_ID = '1GPsuUD-sLAnPEB8one1zM624kNr-_jko';
const NOTIFY_EMAIL    = 'mulubrhan.legesse@bloomfieldinnovations.in';

const TAB_FIRE              = 'FIRE Responses';
const TAB_INDRIYA_LEADS     = 'INDRIYA Registrations';
const TAB_INDRIYA_RESPONSES = 'INDRIYA Responses';

// ============================================================
//  HTTP ENTRY POINTS
// ============================================================
function doPost(e) {
  try {
    const body = parseBody_(e);
    const type = String(body.type || 'FIRE').toUpperCase();

    if (type === 'FIRE')             return handleFire_(body);
    if (type === 'INDRIYA_INTEREST') return handleIndriyaLead_(body);
    if (type === 'INDRIYA_AUDIT')    return handleIndriyaAudit_(body);

    return json_({ ok: false, error: 'Unknown type: ' + type });
  } catch (err) {
    logError_(err);
    try {
      MailApp.sendEmail({
        to: NOTIFY_EMAIL,
        subject: '[FIRE/INDRIYA] doPost error',
        body: 'Error: ' + (err && err.message) + '\n\nStack:\n' + (err && err.stack) + '\n\nPayload:\n' + (e && e.postData && e.postData.contents || '(none)')
      });
    } catch (_) {}
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return ContentService.createTextOutput('FIRE + INDRIYA endpoint is live. POST JSON with a `type` of FIRE | INDRIYA_INTEREST | INDRIYA_AUDIT.')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ============================================================
//  FIRE ASSESSMENT  (unchanged behaviour from the known-working script)
// ============================================================
function handleFire_(p) {
  const Q_IDS = [
    'F1','F2','F3','F4','F5',
    'I1','I2','I3','I4','I5',
    'R1','R2','R3','R4','R5',
    'E1','E2','E3','E4','E5',
    'S1','S2','S3','S4','S5'
  ];
  const headers = [
    'Timestamp','First Name','Last Name','Email','Phone','Role','Department',
    'Institution Name','Institution Type','Student Count','Faculty','Programs',
    'City','Current ERP','Goals',
    'FIRE Index (0-100)','Category','Total Raw (0-125)',
    'F - Functional (/25)','I - Information (/25)','R - Automation (/25)',
    'E - Economic (/25)','S - Strategic (/25)'
  ];
  Q_IDS.forEach(id => { headers.push(id + ' - Answer'); headers.push(id + ' - Score'); });

  const row = [
    nowIso_(p.timestamp),
    p.firstName || '', p.lastName || '', p.email || '', p.phone || '',
    p.role || '', p.department || '',
    p.institutionName || '', p.institutionType || '',
    p.studentCount || '', p.faculty || '', p.programs || '',
    p.city || '', p.currentERP || '', p.goals || '',
    num_(p.fireIndex), p.category || '', num_(p.totalRaw),
    num_(p.pillarF), num_(p.pillarI), num_(p.pillarR), num_(p.pillarE), num_(p.pillarS)
  ];
  Q_IDS.forEach(id => {
    row.push(p[id + '_answer'] !== undefined ? p[id + '_answer'] : '-');
    row.push(p[id + '_score']  !== undefined ? p[id + '_score']  : '-');
  });

  appendRow_(TAB_FIRE, headers, row);

  sendNotify_(
    'FIRE Assessment - ' + (p.institutionName || 'Unknown') +
    ' - Score: ' + num_(p.fireIndex) + '/100 (' + (p.category || '-') + ')',
    buildFireEmail_(p)
  );
  return json_({ ok: true, type: 'FIRE' });
}

// ============================================================
//  INDRIYA LEAD  (soft opt-in from FIRE results page)
// ============================================================
function handleIndriyaLead_(p) {
  const headers = ['Timestamp','Name','Email','Phone','Institution','Goals','Source'];
  const row = [
    nowIso_(p.timestamp),
    p.name || '', p.email || '', p.phone || '',
    p.institution || '', p.goals || '',
    p.source || 'FIRE Results page'
  ];
  appendRow_(TAB_INDRIYA_LEADS, headers, row);

  sendNotify_(
    'INDRIYA lead - ' + (p.institution || p.name || 'Unknown'),
    buildIndriyaLeadEmail_(p)
  );
  return json_({ ok: true, type: 'INDRIYA_INTEREST' });
}

// ============================================================
//  INDRIYA AUDIT  (full submission, PDF saved to Drive)
// ============================================================
function handleIndriyaAudit_(p) {
  const ctx     = p.context || {};
  const scores  = p.scores  || {};
  const byDim   = scores.byDim || {};
  const premium = (p.premium_requested === true || p.premium_requested === 'yes' || p.premium_requested === 'YES');

  // 1. Save PDF to Drive first (if provided) so the row already has the link
  let pdfUrl  = '';
  let pdfName = '';
  let pdfErr  = '';
  if (p.pdf_base64) {
    try {
      const saved = savePdfToDrive_(p.pdf_base64, ctx.institution, ctx.audName, p.pdf_filename);
      pdfUrl  = saved.url;
      pdfName = saved.name;
    } catch (err) {
      pdfErr = String(err && err.message || err);
      logError_(err);
    }
  } else {
    pdfErr = 'client did not send pdf_base64';
  }

  // 2. Write the row
  const headers = [
    'Timestamp','Institution','Type','City','Students','Programs',
    'Auditor','Role','Email','Phone','Focus',
    'D1 Infrastructure (/20)','D2 Experience (/20)','D3 Automation (/20)',
    'D4 Data (/20)','D5 Innovation (/20)','D6 Sustainability (/20)',
    'Total','Max','Completion',
    'Premium Requested','PDF Name','PDF Link','Notes'
  ];
  const completion = premium ? 'Full (6 dimensions)' : 'Free tier (4 dimensions)';
  const row = [
    nowIso_(p.timestamp),
    ctx.institution || '', ctx.iType || '', ctx.city || '', ctx.students || '', ctx.programs || '',
    ctx.audName || '', ctx.audRole || '', ctx.audEmail || '', ctx.audPhone || '', ctx.audContext || '',
    num_(byDim.I), num_(byDim.E), num_(byDim.A), num_(byDim.D),
    num_(byDim.R), num_(byDim.S),
    num_(scores.total), num_(scores.max), completion,
    premium ? 'YES' : 'no',
    pdfName, pdfUrl,
    pdfErr || ''
  ];
  appendRow_(TAB_INDRIYA_RESPONSES, headers, row);

  // 3. Notify
  sendNotify_(
    'INDRIYA Audit - ' + (ctx.institution || 'Unknown') +
    ' - Score: ' + num_(scores.total) + '/' + num_(scores.max || 120) +
    (premium ? ' [PREMIUM REQUESTED]' : ' [free tier]'),
    buildIndriyaAuditEmail_(p, pdfUrl, pdfErr, completion)
  );

  return json_({ ok: true, type: 'INDRIYA_AUDIT', pdfUrl: pdfUrl, pdfErr: pdfErr });
}

// ============================================================
//  DRIVE: save audit PDF in a per-institution sub-folder
// ============================================================
function savePdfToDrive_(base64, institution, auditor, suggestedName) {
  const parent = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const safeInst = sanitize_(institution || 'Unknown Institution');

  // Per-institution sub-folder (re-used across submissions)
  const it = parent.getFoldersByName(safeInst);
  const instFolder = it.hasNext() ? it.next() : parent.createFolder(safeInst);

  // Strip any data: URL prefix the client might include
  const clean = String(base64).replace(/^data:application\/pdf;base64,/, '').replace(/\s+/g, '');
  const bytes = Utilities.base64Decode(clean);

  const tz    = Session.getScriptTimeZone() || 'Asia/Kolkata';
  const stamp = Utilities.formatDate(new Date(), tz, 'yyyyMMdd_HHmmss');
  const tag   = auditor ? ('_' + sanitize_(auditor).replace(/\s+/g, '-')) : '';
  const name  = suggestedName && /\.pdf$/i.test(suggestedName)
    ? suggestedName
    : ('INDRIYA_' + safeInst.replace(/\s+/g, '-') + tag + '_' + stamp + '.pdf');

  const blob = Utilities.newBlob(bytes, 'application/pdf', name);
  const file = instFolder.createFile(blob);
  file.setDescription(
    'INDRIYA Smart Campus Audit - ' + (institution || '') +
    (auditor ? ' - auditor: ' + auditor : '') +
    ' - generated ' + new Date().toISOString()
  );
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (_) {}
  return { url: file.getUrl(), name: name };
}

function sanitize_(s) {
  return String(s || '')
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120) || 'Unknown';
}

// ============================================================
//  EMAIL BODIES
// ============================================================
function buildFireEmail_(p) {
  const L = [];
  L.push('New FIRE Assessment Completed');
  L.push('-----------------------------------------');
  L.push('RESPONDENT');
  L.push('   Name:        ' + compact_(p.firstName, p.lastName));
  L.push('   Role:        ' + fallback_(p.role) + (p.department ? ' (' + p.department + ')' : ''));
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
  L.push('-----------------------------------------');
  L.push('FIRE SCORE');
  L.push('   Index:    ' + fallback_(p.fireIndex) + ' / 100');
  L.push('   Category: ' + fallback_(p.category));
  L.push('   Raw:      ' + fallback_(p.totalRaw) + ' / 125');
  L.push('');
  L.push('   Pillar Breakdown:');
  L.push('     F - Functional:   ' + fallback_(p.pillarF) + '/25');
  L.push('     I - Information:  ' + fallback_(p.pillarI) + '/25');
  L.push('     R - Automation:   ' + fallback_(p.pillarR) + '/25');
  L.push('     E - Economic:     ' + fallback_(p.pillarE) + '/25');
  L.push('     S - Strategic:    ' + fallback_(p.pillarS) + '/25');
  L.push('');
  L.push('-----------------------------------------');
  L.push('GOALS:  ' + fallback_(p.goals, '(not provided)'));
  L.push('-----------------------------------------');
  L.push('');
  L.push('View responses: ' + sheetUrl_());
  return L.join('\n');
}

function buildIndriyaLeadEmail_(p) {
  const L = [];
  L.push('New INDRIYA interest lead');
  L.push('-----------------------------------------');
  L.push('   Name:        ' + fallback_(p.name));
  L.push('   Institution: ' + fallback_(p.institution));
  L.push('   Email:       ' + fallback_(p.email));
  L.push('   Phone:       ' + fallback_(p.phone));
  L.push('   Goals:       ' + fallback_(p.goals, '(not provided)'));
  L.push('   Source:      ' + fallback_(p.source, 'FIRE Results page'));
  L.push('-----------------------------------------');
  L.push('');
  L.push('Sheet: ' + sheetUrl_());
  return L.join('\n');
}

function buildIndriyaAuditEmail_(p, pdfUrl, pdfErr, completion) {
  const ctx    = p.context || {};
  const scores = p.scores  || {};
  const byDim  = scores.byDim || {};
  const premium = (p.premium_requested === true || p.premium_requested === 'yes' || p.premium_requested === 'YES');

  const L = [];
  L.push('New INDRIYA Smart Campus Audit submitted');
  L.push('-----------------------------------------');
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
  L.push('-----------------------------------------');
  L.push('INDRIYA SCORE');
  L.push('   Total:    ' + fallback_(scores.total) + ' / ' + fallback_(scores.max, 120));
  L.push('   Scope:    ' + completion);
  L.push('');
  L.push('   Dimension Breakdown:');
  L.push('     1  Digital Infrastructure:  ' + dimLine_(byDim.I));
  L.push('     2  Student Experience:      ' + dimLine_(byDim.E));
  L.push('     3  Automation & RPA:        ' + dimLine_(byDim.A));
  L.push('     4  Data Intelligence:       ' + dimLine_(byDim.D));
  L.push('     5  Innovation & Industry:   ' + dimLine_(byDim.R));
  L.push('     6  Sustainability:          ' + dimLine_(byDim.S));
  L.push('');
  L.push('-----------------------------------------');
  L.push('PREMIUM REQUESTED:  ' + (premium ? 'YES - please prioritise follow-up' : 'no'));
  L.push('-----------------------------------------');
  L.push('');
  L.push('REPORT PDF (photos embedded):');
  L.push(pdfUrl ? pdfUrl : ('   (not generated' + (pdfErr ? ' - ' + pdfErr : '') + ')'));
  L.push('');
  L.push('Responses sheet: ' + sheetUrl_());
  return L.join('\n');
}

function dimLine_(v) {
  if (v === null || v === undefined || v === '') return 'locked / not rated';
  return v + '/20';
}

// ============================================================
//  SHEET / EMAIL HELPERS
// ============================================================
function appendRow_(name, headers, row) {
  const sh = getSheet_(name, headers);
  sh.appendRow(row);
}

function getSheet_(name, headers) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold').setBackground('#044a3d').setFontColor('white').setWrap(true);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold').setBackground('#044a3d').setFontColor('white').setWrap(true);
  }
  return sh;
}

function sheetUrl_() { return 'https://docs.google.com/spreadsheets/d/' + SHEET_ID; }

function sendNotify_(subject, body) {
  try {
    if (!NOTIFY_EMAIL) return;
    MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: subject, body: body });
  } catch (err) { logError_(err); }
}

// ============================================================
//  UTILITIES
// ============================================================
function parseBody_(e) {
  if (!e) return {};
  if (e.postData && e.postData.contents) {
    try { return JSON.parse(e.postData.contents); } catch (_) {}
  }
  return e.parameter || {};
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function fallback_(v, alt) {
  if (v === null || v === undefined) return alt != null ? alt : '-';
  const s = String(v).trim();
  return s.length ? s : (alt != null ? alt : '-');
}

function compact_(a, b) {
  const parts = [a, b].map(x => (x == null ? '' : String(x).trim())).filter(Boolean);
  return parts.length ? parts.join(' ') : '-';
}

function num_(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return isNaN(n) ? v : n;
}

function nowIso_(v) { return v || new Date().toISOString(); }

function logError_(err) {
  try { console.error(err); } catch (_) {}
  try { Logger.log(err && err.stack || err); } catch (_) {}
}

// ============================================================
//  SELF-TEST  (run manually from the Apps Script editor)
//  Drops one dummy row into each tab + sends one email to
//  NOTIFY_EMAIL + creates one tiny PDF in DRIVE_FOLDER_ID.
// ============================================================
function selfTest() {
  handleFire_({
    type: 'FIRE',
    firstName: 'Test', lastName: 'User', email: 'test@example.com',
    institutionName: 'Self-Test University', institutionType: 'Private',
    fireIndex: 66, category: 'Advanced', totalRaw: 83,
    pillarF: 18, pillarI: 16, pillarR: 17, pillarE: 15, pillarS: 17,
    goals: 'Self-test run from the Apps Script editor.'
  });
  handleIndriyaLead_({
    type: 'INDRIYA_INTEREST',
    name: 'Test Auditor', email: 'test@example.com',
    institution: 'Self-Test University', phone: '+91 0000000000',
    goals: 'Self-test lead.'
  });
  handleIndriyaAudit_({
    type: 'INDRIYA_AUDIT',
    context: { institution: 'Self-Test University', iType: 'Private', city: 'Remote', students: '5000',
               audName: 'Test Auditor', audRole: 'Registrar', audEmail: 'test@example.com', audPhone: '', audContext: 'self-test' },
    ratings: {}, remarks: {},
    scores: { byDim: { I: 14, E: 12, A: 10, D: 11 }, total: 47, max: 80 },
    premium_requested: false,
    pdf_base64: Utilities.base64Encode('%PDF-1.4\n%self-test\n'),
    pdf_filename: 'INDRIYA_selftest.pdf'
  });
}
