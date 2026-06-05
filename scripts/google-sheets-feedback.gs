/**
 * Creative Asset Extractor — feedback webhook for Google Sheets.
 *
 * Setup (one time, in the target spreadsheet):
 * 1. Open https://docs.google.com/spreadsheets/d/1dxhHtdi06oOwh-9d-ZdMxo8Wa7LIYJBu7lWXTsaP2xI/edit
 * 2. Extensions → Apps Script
 * 3. Replace Code.gs with this file and save
 * 4. Deploy → New deployment → Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Copy the Web app URL into .env as GOOGLE_SHEET_FEEDBACK_WEBHOOK_URL
 *    or ~/.creative-asset-extractor/feedback-config.json as sheetWebhookUrl
 */
function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const name = String(payload.name || '').trim();
    const suggestions = String(payload.suggestions || '').trim();
    const submittedAt = String(payload.submittedAt || new Date().toISOString());
    const appVersion = String(payload.appVersion || '').trim();

    if (!name || !suggestions) {
      return jsonResponse({ ok: false, error: 'Name and suggestions are required.' });
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    ensureHeaders_(sheet);
    sheet.appendRow([name, suggestions, submittedAt, appVersion]);

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function ensureHeaders_(sheet) {
  const firstCell = String(sheet.getRange(1, 1).getValue() || '').trim();
  if (firstCell) return;
  sheet.getRange(1, 1, 1, 4).setValues([['Name', 'Suggestions', 'Submitted At', 'App Version']]);
}

function jsonResponse(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON
  );
}
