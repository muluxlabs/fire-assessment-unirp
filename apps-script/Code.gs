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
//  INDRIYA AUTH GATE
//  Only emails on these domains can request an OTP and start an
//  INDRIYA audit. Add additional Bloomfield-owned domains here.
// ============================================================
const ALLOWED_OTP_DOMAINS    = ['bloomfieldinnovations.in'];
const OTP_TTL_SECONDS        = 600;     // OTP valid for 10 minutes
const OTP_MAX_ATTEMPTS       = 5;       // wrong tries before invalidating
const OTP_HOURLY_LIMIT       = 5;       // OTP requests per email per hour
const OTP_TOKEN_TTL_SECONDS  = 7200;    // signed audit token = 2 hours

// ============================================================
//  HTTP ENTRY POINTS
// ============================================================
function doPost(e) {
  try {
    const body = parseBody_(e);
    const type = String(body.type || 'FIRE').toUpperCase();

    if (type === 'FIRE')                 return handleFire_(body);
    if (type === 'INDRIYA_INTEREST')     return handleIndriyaLead_(body);
    if (type === 'INDRIYA_AUDIT')        return handleIndriyaAudit_(body);
    if (type === 'INDRIYA_OTP_REQUEST')  return handleIndriyaOtpRequest_(body);
    if (type === 'INDRIYA_OTP_VERIFY')   return handleIndriyaOtpVerify_(body);

    return withCors_(json_({ ok: false, error: 'Unknown type: ' + type }));
  } catch (err) {
    logError_(err);
    try {
      MailApp.sendEmail({
        to: NOTIFY_EMAIL,
        subject: '[FIRE/INDRIYA] doPost error',
        body: 'Error: ' + (err && err.message) + '\n\nStack:\n' + (err && err.stack) + '\n\nPayload:\n' + (e && e.postData && e.postData.contents || '(none)')
      });
    } catch (_) {}
    return withCors_(json_({ ok: false, error: String(err && err.message || err) }));
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
    'Record ID','Status','Created At','Last Updated',
    'Timestamp','First Name','Last Name','Email','Phone','Role','Department',
    'Institution Name','Institution Type','Student Count','Faculty','Programs',
    'City','Current ERP','Goals',
    'FIRE Index (0-100)','Category','Total Raw (0-125)',
    'F - Functional (/25)','I - Information (/25)','R - Automation (/25)',
    'E - Economic (/25)','S - Strategic (/25)'
  ];
  Q_IDS.forEach(id => { headers.push(id + ' - Answer'); headers.push(id + ' - Score'); });

  const status = String(p.status || 'completed').toLowerCase() === 'draft' ? 'Draft' : 'Completed';
  const isDraft = (status === 'Draft');
  const recordId = String(p.recordId || '').trim();
  const nowStamp = nowIso_();
  const sh = getSheet_(TAB_FIRE, headers);
  ensureHeaders_(sh, headers);

  // Look up an existing draft for this recordId (created when the user clicked Start Assessment).
  const existing = recordId ? findRowByRecordId_(sh, recordId) : null;
  const createdAt = existing ? (existing.row[2] || nowStamp) : nowStamp;

  const row = [
    recordId, status, createdAt, nowStamp,
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

  // Pad to header width so every column is filled even when the sheet has been extended.
  while (row.length < headers.length) row.push('');

  if (existing) {
    // Overwrite the draft row in place — preserves the original sheet position and createdAt.
    sh.getRange(existing.rowIndex, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
  }

  // Only email the consultant when the assessment is actually completed; drafts are silent.
  if (!isDraft) {
    sendNotify_(
      'FIRE Assessment - ' + (p.institutionName || 'Unknown') +
      ' - Score: ' + num_(p.fireIndex) + '/100 (' + (p.category || '-') + ')',
      buildFireEmail_(p)
    );
  }
  return json_({ ok: true, type: 'FIRE', status: status, recordId: recordId });
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
//  INDRIYA AUDIT  (full submission, PDF built & saved server-side)
// ============================================================
function handleIndriyaAudit_(p) {
  const ctx     = p.context || {};
  const scores  = p.scores  || {};
  const byDim   = scores.byDim || {};
  const premium = (p.premium_requested === true || p.premium_requested === 'yes' || p.premium_requested === 'YES');

  // Validate the auth token issued by the OTP gate. We do NOT block submission
  // when invalid, since the audit page is fire-and-forget (no-cors) and the
  // client cannot react to a rejection. Instead we record the auth status on
  // the row and raise an alert to the security mailbox for review.
  const tokenInfo = validateAuditToken_(p.auth_token, ctx.audEmail);
  const authStatus = tokenInfo.ok ? 'verified' : ('unauthenticated' + (tokenInfo.reason ? ' (' + tokenInfo.reason + ')' : ''));
  if (!tokenInfo.ok) {
    try {
      sendNotify_(
        '[INDRIYA SECURITY] Audit submitted without a valid token',
        'Reason: ' + (tokenInfo.reason || 'unknown') +
        '\nInstitution: ' + (ctx.institution || '-') +
        '\nAuditor: ' + (ctx.audName || '-') + ' <' + (ctx.audEmail || '-') + '>' +
        '\nUser-Agent / IP unknown (Apps Script web app).'
      );
    } catch (_) {}
  }

  // 1. Build and save the PDF. Prefer the client-supplied base64 (legacy path)
  //    but normally we render the PDF from the payload on the server.
  let pdfUrl  = '';
  let pdfName = '';
  let pdfErr  = '';
  try {
    let saved;
    if (p.pdf_base64) {
      saved = savePdfToDrive_(p.pdf_base64, ctx.institution, ctx.audName, p.pdf_filename);
    } else {
      const html = buildAuditHtml_(p, premium);
      const pdfBlob = Utilities.newBlob(html, 'text/html', 'audit.html').getAs('application/pdf');
      saved = savePdfBlobToDrive_(pdfBlob, ctx.institution, ctx.audName, p.pdf_filename);
    }
    pdfUrl  = saved.url;
    pdfName = saved.name;
  } catch (err) {
    pdfErr = String(err && err.message || err);
    logError_(err);
  }

  // 2. Write the row
  const headers = [
    'Timestamp','Auth Status','Institution','Type','City','Students','Programs',
    'Auditor','Role','Email','Phone','Focus',
    'D1 Infrastructure (/20)','D2 Experience (/20)','D3 Automation (/20)',
    'D4 Data (/20)','D5 Innovation (/20)','D6 Sustainability (/20)','D7 Readiness (/20)',
    'Total','Max','Completion',
    'Premium Requested','PDF Name','PDF Link','Notes'
  ];
  // Free path = 4 free dims. Premium = 4 free + 3 premium (Innovation, Sustainability, Readiness).
  const completion = premium ? 'Full (7 dimensions)' : 'Free tier (4 dimensions)';
  const row = [
    nowIso_(p.timestamp), authStatus,
    ctx.institution || '', ctx.iType || '', ctx.city || '', ctx.students || '', ctx.programs || '',
    ctx.audName || '', ctx.audRole || '', ctx.audEmail || '', ctx.audPhone || '', ctx.audContext || '',
    num_(byDim.I), num_(byDim.E), num_(byDim.A), num_(byDim.D),
    num_(byDim.R), num_(byDim.S), num_(byDim.C),
    num_(scores.total), num_(scores.max), completion,
    premium ? 'YES' : 'no',
    pdfName, pdfUrl,
    pdfErr || ''
  ];
  // Use ensureHeaders_ so existing sheets get the new columns without manual edits.
  const sh = getSheet_(TAB_INDRIYA_RESPONSES, headers);
  ensureHeaders_(sh, headers);
  while (row.length < sh.getLastColumn()) row.push('');
  sh.appendRow(row);

  // 3. Notify
  sendNotify_(
    'INDRIYA Audit - ' + (ctx.institution || 'Unknown') +
    ' - Score: ' + num_(scores.total) + '/' + num_(scores.max || (premium ? 140 : 80)) +
    (premium ? ' [PREMIUM REQUESTED]' : ' [free tier]') +
    (tokenInfo.ok ? '' : ' [UNAUTH]'),
    buildIndriyaAuditEmail_(p, pdfUrl, pdfErr, completion, authStatus)
  );

  return withCors_(json_({ ok: true, type: 'INDRIYA_AUDIT', pdfUrl: pdfUrl, pdfErr: pdfErr, authStatus: authStatus }));
}

// ============================================================
//  INDRIYA OTP GATE
//  - INDRIYA_OTP_REQUEST: validate Bloomfield-domain email, email a 6-digit
//    code, cache it under a client-supplied nonce.
//  - INDRIYA_OTP_VERIFY:  check nonce+code, mint a short-lived audit token
//    that the client must send back with the final audit submission.
// ============================================================
function handleIndriyaOtpRequest_(p) {
  const email = String(p.email || '').trim().toLowerCase();
  const nonce = String(p.nonce || '').trim();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return withCors_(json_({ ok: false, error: 'Please enter a valid email address.' }));
  }
  const domain = email.split('@')[1] || '';
  if (ALLOWED_OTP_DOMAINS.indexOf(domain) === -1) {
    return withCors_(json_({ ok: false, error: 'INDRIYA audits are restricted to Bloomfield Innovations team email addresses (@' + ALLOWED_OTP_DOMAINS.join(', @') + ').' }));
  }
  if (nonce.length < 8 || nonce.length > 80) {
    return withCors_(json_({ ok: false, error: 'Invalid request nonce.' }));
  }

  // Rate-limit OTPs per email per hour (best-effort, CacheService is in-memory)
  const cache = CacheService.getScriptCache();
  const rateKey = 'indriya_otp_rate:' + email;
  const cur = parseInt(cache.get(rateKey) || '0', 10);
  if (cur >= OTP_HOURLY_LIMIT) {
    return withCors_(json_({ ok: false, error: 'Too many verification codes requested for this address. Please try again in an hour.' }));
  }
  cache.put(rateKey, String(cur + 1), 3600);

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  cache.put('indriya_otp:' + nonce, JSON.stringify({ email: email, otp: otp, attempts: 0, ts: Date.now() }), OTP_TTL_SECONDS);

  try {
    MailApp.sendEmail({
      to: email,
      subject: 'INDRIYA Audit verification code: ' + otp,
      htmlBody:
        '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;color:#1a2a26;">' +
          '<div style="background:#044a3d;color:white;padding:18px 24px;border-radius:8px 8px 0 0;">' +
            '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.7);">Bloomfield Innovations</div>' +
            '<div style="font-family:Georgia,serif;font-size:22px;font-weight:700;margin-top:4px;">INDRIYA Smart Campus Audit</div>' +
          '</div>' +
          '<div style="border:1px solid #e0ddd4;border-top:none;border-radius:0 0 8px 8px;padding:24px;">' +
            '<p style="margin:0 0 12px;">Hello,</p>' +
            '<p style="margin:0 0 14px;line-height:1.55;">Use the one-time code below to start your INDRIYA audit. The code is valid for 10 minutes and can only be used once.</p>' +
            '<div style="font-size:30px;font-weight:700;letter-spacing:8px;color:#044a3d;background:#fbf6e8;border:2px solid #c9a84c;border-radius:10px;padding:16px 24px;text-align:center;margin:18px 0;">' + otp + '</div>' +
            '<p style="margin:0 0 8px;font-size:12.5px;color:#555;line-height:1.6;">If you did not request this code, you can safely ignore this email. No action will be taken on your account.</p>' +
            '<hr style="margin:18px 0;border:none;border-top:1px solid #e0ddd4;">' +
            '<p style="margin:0;font-size:11px;color:#9a9a9a;">INDRIYA &middot; A Bloomfield Innovations programme &middot; Powered by UniRP</p>' +
          '</div>' +
        '</div>'
    });
  } catch (e) {
    logError_(e);
    return withCors_(json_({ ok: false, error: 'We could not send the verification email. Please retry in a moment.' }));
  }

  return withCors_(json_({ ok: true, type: 'INDRIYA_OTP_REQUEST', expiresInSeconds: OTP_TTL_SECONDS }));
}

function handleIndriyaOtpVerify_(p) {
  const nonce = String(p.nonce || '').trim();
  const otp   = String(p.otp || '').trim();
  if (!nonce) return withCors_(json_({ ok: false, error: 'Missing verification nonce.' }));
  if (!/^\d{4,8}$/.test(otp)) return withCors_(json_({ ok: false, error: 'Enter the 6-digit code from your email.' }));

  const cache = CacheService.getScriptCache();
  const raw = cache.get('indriya_otp:' + nonce);
  if (!raw) {
    return withCors_(json_({ ok: false, error: 'Your verification code has expired. Please request a new one.' }));
  }
  let stored;
  try { stored = JSON.parse(raw); } catch (_) { return withCors_(json_({ ok: false, error: 'Invalid verification record. Please request a new code.' })); }

  if ((stored.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    cache.remove('indriya_otp:' + nonce);
    return withCors_(json_({ ok: false, error: 'Too many wrong attempts. Please request a new code.' }));
  }
  if (String(stored.otp) !== otp) {
    stored.attempts = (stored.attempts || 0) + 1;
    cache.put('indriya_otp:' + nonce, JSON.stringify(stored), OTP_TTL_SECONDS);
    const left = OTP_MAX_ATTEMPTS - stored.attempts;
    return withCors_(json_({ ok: false, error: 'Incorrect code. ' + (left > 0 ? left + ' attempt' + (left === 1 ? '' : 's') + ' remaining.' : 'No attempts left.') }));
  }

  cache.remove('indriya_otp:' + nonce);
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  cache.put('indriya_audit_token:' + token, stored.email, OTP_TOKEN_TTL_SECONDS);
  return withCors_(json_({ ok: true, type: 'INDRIYA_OTP_VERIFY', token: token, email: stored.email, expiresInSeconds: OTP_TOKEN_TTL_SECONDS }));
}

// Returns { ok: bool, reason: string, email: string }
function validateAuditToken_(token, claimedEmail) {
  if (!token) return { ok: false, reason: 'missing_token' };
  const t = String(token).trim();
  if (t.length < 16 || t.length > 200) return { ok: false, reason: 'malformed_token' };
  const cache = CacheService.getScriptCache();
  const cached = cache.get('indriya_audit_token:' + t);
  if (!cached) return { ok: false, reason: 'expired_or_unknown_token' };
  if (claimedEmail && String(cached).toLowerCase() !== String(claimedEmail).trim().toLowerCase()) {
    return { ok: false, reason: 'email_mismatch', email: cached };
  }
  return { ok: true, email: cached };
}

// Apps Script ContentService responses already include permissive CORS for
// GET. For POST we keep the result simple-text + JSON; modern browsers can
// read it because the request itself is sent with Content-Type: text/plain
// (a "simple request" that does NOT trigger a preflight). This helper is a
// placeholder for future fine-grained CORS handling.
function withCors_(out) { return out; }

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

// Saves an already-built PDF blob to the per-institution Drive sub-folder
// under DRIVE_FOLDER_ID. Mirrors savePdfToDrive_ but skips base64 decoding.
function savePdfBlobToDrive_(pdfBlob, institution, auditor, suggestedName) {
  const parent   = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const safeInst = sanitize_(institution || 'Unknown Institution');
  const it       = parent.getFoldersByName(safeInst);
  const instFolder = it.hasNext() ? it.next() : parent.createFolder(safeInst);

  const tz    = Session.getScriptTimeZone() || 'Asia/Kolkata';
  const stamp = Utilities.formatDate(new Date(), tz, 'yyyyMMdd_HHmmss');
  const tag   = auditor ? ('_' + sanitize_(auditor).replace(/\s+/g, '-')) : '';
  const name  = suggestedName && /\.pdf$/i.test(suggestedName)
    ? suggestedName
    : ('INDRIYA_' + safeInst.replace(/\s+/g, '-') + tag + '_' + stamp + '.pdf');

  pdfBlob.setName(name);
  const file = instFolder.createFile(pdfBlob);
  file.setDescription(
    'INDRIYA Smart Campus Audit - ' + (institution || '') +
    (auditor ? ' - auditor: ' + auditor : '') +
    ' - generated server-side ' + new Date().toISOString()
  );
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (_) {}
  return { url: file.getUrl(), name: name };
}

// Builds the full HTML source for the INDRIYA audit PDF. User-uploaded photos
// arrive from the client as data URLs (so they embed fine) but sample
// reference photos arrive as external HTTPS URLs to /assets/samples/*.jpg.
// Google's HTML->PDF converter (Utilities.newBlob(html).getAs('application/pdf'))
// does NOT fetch external images at convert time, which is why those samples
// were missing from the Drive copy. We pre-fetch them once each via
// UrlFetchApp and rewrite the payload to inline base64 data URLs.
function embedSampleImagesInPayload_(dims) {
  const memo = {}; // url -> data URL ('' if fetch failed)
  (dims || []).forEach(function(dim) {
    (dim.items || []).forEach(function(it) {
      const s = it && it.sample;
      if (!s || !s.src || /^data:/i.test(s.src)) return;
      const url = s.src;
      if (!(url in memo)) {
        try {
          const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
          const code = resp.getResponseCode();
          if (code >= 200 && code < 300) {
            const blob = resp.getBlob();
            const ct = blob.getContentType() || 'image/jpeg';
            memo[url] = 'data:' + ct + ';base64,' + Utilities.base64Encode(blob.getBytes());
          } else {
            memo[url] = '';
            logError_(new Error('Sample fetch HTTP ' + code + ' for ' + url));
          }
        } catch (e) {
          memo[url] = '';
          logError_(e);
        }
      }
      if (memo[url]) it.sample = { src: memo[url], caption: s.caption };
    });
  });
}

function buildAuditHtml_(p, premium) {
  const ctx    = p.context || {};
  const scores = p.scores  || {};
  const byDim  = scores.byDim || {};
  const dims   = Array.isArray(p.dimensions) ? p.dimensions : [];

  // Inline all sample reference images so they survive the HTML->PDF conversion.
  embedSampleImagesInPayload_(dims);

  const tz    = Session.getScriptTimeZone() || 'Asia/Kolkata';
  const date  = Utilities.formatDate(new Date(), tz, 'dd MMMM yyyy, HH:mm');
  const total = (scores.total  == null ? '-' : scores.total);
  const max   = (scores.max    == null ? (premium ? 140 : 80) : scores.max);
  const pct   = (typeof scores.total === 'number' && max) ? Math.round((scores.total / max) * 100) : '-';
  const scope = premium ? 'Full INDRIYA audit - 7 dimensions' : 'Free tier - 4 technical dimensions';

  const dimMap = [
    ['I','Digital Infrastructure'],
    ['E','Student Experience'],
    ['A','Automation &amp; RPA'],
    ['D','Data Intelligence'],
    ['R','Innovation &amp; Industry'],
    ['S','Sustainability &amp; Future Readiness'],
    ['C','Smart Campus Readiness &amp; Adoption']
  ];
  const scorecardRows = dimMap.map(function(d){
    var v = byDim[d[0]];
    var val = (v == null || v === '') ? '<em style="color:#999">not rated</em>' : (v + ' / 20');
    return '<tr><td>' + d[1] + '</td><td style="text-align:right;font-weight:600">' + val + '</td></tr>';
  }).join('');

  function dimSection(dim) {
    // Each user-uploaded photo is paired with the item-level sample reference
    // (passed in from the client as it.sample) so the consultant can compare
    // on-ground reality against the benchmark for that specific question.
    var items = (dim.items || []).map(function(it){
      var sample = it.sample || null;
      var stars = (typeof it.rating === 'number')
        ? ('&#9733;'.repeat(it.rating + 1) + '<span style="color:#d5d5d5">' + '&#9733;'.repeat(4 - it.rating) + '</span>')
        : '<span style="color:#b7b7b7">(not rated)</span>';
      var remark = it.remark ? htmlEscape_(it.remark) : '<em style="color:#9a9a9a">No written observation.</em>';
      var photos = (it.photos || []).filter(function(ph){ return ph && ph.dataUrl; });
      var photoHtml = '';
      if (photos.length) {
        photoHtml = '<div style="margin-top:6px;display:flex;flex-direction:column;gap:6px;">' +
          photos.map(function(ph){
            var sampleCol = sample && sample.src
              ? '<div style="width:50%;border-left:1px solid #e0ddd4;">' +
                  '<div style="font-size:8px;letter-spacing:1px;text-transform:uppercase;font-weight:700;color:#8a6a1e;background:#fbf6e8;padding:3px 6px;">Sample reference</div>' +
                  '<img src="' + sample.src + '" style="display:block;width:100%;height:110px;object-fit:cover;">' +
                  '<div style="padding:4px 7px;font-size:9px;color:#7a6030;line-height:1.4;font-style:italic;background:#fffaf0;">' + htmlEscape_(sample.caption || '') + '</div>' +
                '</div>'
              : '<div style="width:50%;background:#fafafa;display:flex;align-items:center;justify-content:center;font-size:9px;color:#b0b0b0;">No sample.</div>';
            return '<div style="border:1px solid #e0ddd4;border-radius:6px;overflow:hidden;page-break-inside:avoid;display:flex;">' +
                     '<div style="width:50%;">' +
                       '<div style="font-size:8px;letter-spacing:1px;text-transform:uppercase;font-weight:700;color:#044a3d;background:#e8f5f0;padding:3px 6px;">On-ground photo</div>' +
                       '<img src="' + ph.dataUrl + '" style="display:block;width:100%;height:110px;object-fit:cover;">' +
                       '<div style="padding:4px 7px;font-size:9px;color:#3a3a3a;line-height:1.4;">' +
                          (ph.desc ? htmlEscape_(ph.desc) : '<em style="color:#a6a6a6">No description.</em>') +
                       '</div>' +
                     '</div>' +
                     sampleCol +
                   '</div>';
          }).join('') +
        '</div>';
      }
      return '<tr>' +
        '<td style="padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top;width:38%;">' +
          '<div style="font-weight:600;color:#0a3a2f;font-size:11.5px;">' + htmlEscape_(it.title || '') + '</div>' +
          '<div style="font-size:9.5px;color:#8a8a8a;margin-top:2px;">' + htmlEscape_(it.hint || '') + '</div>' +
        '</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top;width:18%;font-size:13px;color:#d19a2c;">' + stars +
          '<div style="font-size:9.5px;color:#555;font-weight:600;">' + htmlEscape_(it.ratingLabel || '') + '</div>' +
        '</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top;width:44%;font-size:10.5px;color:#222;line-height:1.45;">' +
          remark + photoHtml +
        '</td>' +
      '</tr>';
    }).join('');

    return '<section style="page-break-inside:avoid;margin-top:18px;">' +
      '<h2 style="font-size:15px;margin:0 0 6px;color:#044a3d;border-bottom:2px solid #c9a84c;padding-bottom:4px;">' +
        htmlEscape_(dim.name || '') +
      '</h2>' +
      '<table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">' +
        '<thead><tr style="background:#f4f1e8;">' +
          '<th style="text-align:left;padding:6px 10px;font-size:9.5px;color:#6a6a6a;text-transform:uppercase;letter-spacing:1px;">Item</th>' +
          '<th style="text-align:left;padding:6px 10px;font-size:9.5px;color:#6a6a6a;text-transform:uppercase;letter-spacing:1px;">Rating</th>' +
          '<th style="text-align:left;padding:6px 10px;font-size:9.5px;color:#6a6a6a;text-transform:uppercase;letter-spacing:1px;">Observation &amp; Evidence</th>' +
        '</tr></thead>' +
        '<tbody>' + items + '</tbody>' +
      '</table>' +
    '</section>';
  }

  var dimensionsHtml = dims.length
    ? dims.map(dimSection).join('')
    : '<p style="color:#8a8a8a;font-style:italic;">No dimension data submitted.</p>';

  return '' +
  '<!doctype html><html><head><meta charset="utf-8"><title>INDRIYA Audit - ' + htmlEscape_(ctx.institution || '') + '</title>' +
  '<style>' +
    '@page{size:A4;margin:14mm 14mm;}' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#1a2a26;margin:0;padding:0;font-size:11px;}' +
    'h1,h2,h3{font-family:Georgia,\'Times New Roman\',serif;}' +
    '.cover{background:#044a3d;color:#fff;padding:36px 32px 30px;border-radius:10px;}' +
    '.cover h1{font-size:28px;margin:0 0 6px;letter-spacing:1px;}' +
    '.cover .sub{font-size:12px;opacity:0.85;letter-spacing:2px;text-transform:uppercase;}' +
    '.cover .inst{font-size:20px;margin:22px 0 4px;color:#fff;}' +
    '.cover .meta{font-size:11px;opacity:0.85;line-height:1.7;}' +
    '.scorecard{margin:18px 0 6px;display:flex;gap:14px;}' +
    '.score-big{background:#fbf6e8;border:1.5px solid #c9a84c;border-radius:10px;padding:16px 18px;width:42%;}' +
    '.score-big .num{font-size:38px;font-weight:700;color:#044a3d;line-height:1;}' +
    '.score-big .lbl{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8a6a1e;margin-top:4px;}' +
    '.score-list{flex:1;border:1px solid #e0ddd4;border-radius:10px;padding:4px 12px;}' +
    '.score-list table{width:100%;border-collapse:collapse;font-size:11px;}' +
    '.score-list td{padding:5px 0;border-bottom:1px dotted #eee;}' +
    '.score-list tr:last-child td{border-bottom:none;}' +
    '.tag{display:inline-block;background:#fff;color:#044a3d;border-radius:14px;padding:3px 12px;font-size:10px;font-weight:600;letter-spacing:1px;margin-top:6px;}' +
  '</style></head><body>' +

    '<div class="cover">' +
      '<div class="sub">INDRIYA Smart Campus Audit</div>' +
      '<h1>Digital Transformation Report</h1>' +
      '<div class="inst">' + htmlEscape_(ctx.institution || 'Institution') + '</div>' +
      '<div class="meta">' +
        (ctx.iType     ? 'Type: '     + htmlEscape_(ctx.iType)    + '<br>' : '') +
        (ctx.city      ? 'Location: ' + htmlEscape_(ctx.city)     + '<br>' : '') +
        (ctx.students  ? 'Students: ' + htmlEscape_(ctx.students) + '<br>' : '') +
        (ctx.programs  ? 'Programs: ' + htmlEscape_(ctx.programs) + '<br>' : '') +
        '<br>Auditor: ' + htmlEscape_(ctx.audName || '-') + (ctx.audRole ? ' (' + htmlEscape_(ctx.audRole) + ')' : '') + '<br>' +
        'Generated: ' + date + ' IST' +
      '</div>' +
      '<span class="tag">' + htmlEscape_(scope) + (premium ? ' &middot; PRIORITY' : '') + '</span>' +
    '</div>' +

    '<div class="scorecard">' +
      '<div class="score-big">' +
        '<div class="num">' + total + '<span style="font-size:16px;font-weight:500;color:#8a6a1e;">/' + max + '</span></div>' +
        '<div class="lbl">INDRIYA Index &middot; ' + pct + (pct === '-' ? '' : '%') + '</div>' +
      '</div>' +
      '<div class="score-list">' +
        '<table>' + scorecardRows + '</table>' +
      '</div>' +
    '</div>' +

    '<h2 style="font-size:14px;margin:22px 0 4px;color:#044a3d;letter-spacing:1px;">DIMENSION-LEVEL FINDINGS</h2>' +
    '<p style="font-size:10.5px;color:#555;margin:0 0 6px;line-height:1.5;">' +
      'The following pages detail the on-ground rating, the auditor\'s written observation and the attached photo evidence for each item in each completed dimension. Photos are held as colour evidence and are reviewed by the UniRP consultant team for on-site verification.' +
    '</p>' +

    dimensionsHtml +

    '<footer style="margin-top:26px;padding-top:10px;border-top:1px solid #e0ddd4;font-size:9px;color:#8a8a8a;text-align:center;">' +
      'Generated by INDRIYA Smart Campus Audit &middot; UniRP by Bloomfield Innovations (Marwadi Chandarana Group) &middot; ' + date + ' IST' +
    '</footer>' +

  '</body></html>';
}

function htmlEscape_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function buildIndriyaAuditEmail_(p, pdfUrl, pdfErr, completion, authStatus) {
  const ctx    = p.context || {};
  const scores = p.scores  || {};
  const byDim  = scores.byDim || {};
  const premium = (p.premium_requested === true || p.premium_requested === 'yes' || p.premium_requested === 'YES');

  const L = [];
  L.push('New INDRIYA Smart Campus Audit submitted');
  L.push('-----------------------------------------');
  if (authStatus) L.push('AUTH STATUS:  ' + authStatus);
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
  L.push('   Total:    ' + fallback_(scores.total) + ' / ' + fallback_(scores.max, premium ? 140 : 80));
  L.push('   Scope:    ' + completion);
  L.push('');
  L.push('   Dimension Breakdown:');
  L.push('     1  Digital Infrastructure:    ' + dimLine_(byDim.I));
  L.push('     2  Student Experience:        ' + dimLine_(byDim.E));
  L.push('     3  Automation & RPA:          ' + dimLine_(byDim.A));
  L.push('     4  Data Intelligence:         ' + dimLine_(byDim.D));
  L.push('     5  Innovation & Industry:     ' + dimLine_(byDim.R));
  L.push('     6  Sustainability:            ' + dimLine_(byDim.S));
  L.push('     7  Readiness & Adoption:      ' + dimLine_(byDim.C));
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

  // Make sure every header in `desired` exists in the sheet's header row.
  // Existing data rows are untouched; missing headers are appended on the right.
  function ensureHeaders_(sh, desired) {
  const lastCol = sh.getLastColumn();
  if (lastCol === 0) {
  sh.appendRow(desired);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, desired.length)
  .setFontWeight('bold').setBackground('#044a3d').setFontColor('white').setWrap(true);
  return;
  }
  const current = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const missing = desired.filter(h => current.indexOf(h) === -1);
  if (missing.length) {
  sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing])
  .setFontWeight('bold').setBackground('#044a3d').setFontColor('white').setWrap(true);
  }
  }

  // Find a row by Record ID (which lives in column A under the new schema).
  // Returns { rowIndex, row } or null if not found. rowIndex is 1-based.
  function findRowByRecordId_(sh, recordId) {
  if (!recordId) return null;
  const last = sh.getLastRow();
  if (last < 2) return null;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
  if (String(ids[i][0]) === recordId) {
  const colCount = Math.max(sh.getLastColumn(), 1);
  const row = sh.getRange(i + 2, 1, 1, colCount).getValues()[0];
  return { rowIndex: i + 2, row: row };
  }
  }
  return null;
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
  // 1x1 red JPEG data URL, just enough to prove photo embedding works.
  var tinyJpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiiv//Z';
  handleIndriyaAudit_({
    type: 'INDRIYA_AUDIT',
    context: { institution: 'Self-Test University', iType: 'Private', city: 'Remote', students: '5000',
               audName: 'Test Auditor', audRole: 'Registrar', audEmail: 'test@example.com', audPhone: '', audContext: 'self-test' },
    ratings: { I1: 2, I2: 3 }, remarks: { I1: 'Wi-Fi has a dead zone in Block B.', I2: '3 of 12 rooms have interactive displays.' },
    scores: { byDim: { I: 14, E: 12, A: 10, D: 11 }, total: 47, max: 80 },
    premium_requested: false,
    dimensions: [{
      key: 'I', name: 'Digital Infrastructure', tier: 'free',
      items: [
        { id:'I1', title:'Campus-wide Wi-Fi coverage', hint:'Any dead zones?', rating:2, ratingLabel:'Intermediate', remark:'Dead zone near Block B west wing.', photos:[{dataUrl:tinyJpeg, desc:'Router map from IT office.'}] },
        { id:'I2', title:'Smart classrooms',          hint:'% with interactive displays', rating:3, ratingLabel:'Advanced',    remark:'3 of 12 rooms have interactive displays.', photos:[] }
      ]
    }],
    pdf_filename: 'INDRIYA_selftest.pdf'
  });
}
