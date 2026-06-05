/**
 * Creative Asset Extractor — feedback webhook for Google Sheets.
 */
function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const name = String(payload.name || '').trim();
    const suggestions = String(payload.suggestions || '').trim();
    const submittedAt = String(payload.submittedAt || new Date().toISOString());
    const appVersion = String(payload.appVersion || '').trim();

    if (!name || !suggestions) {
      return jsonResponse_({ ok: false, error: 'Name and suggestions are required.' });
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    ensureHeaders_(sheet);
    sheet.appendRow([name, suggestions, submittedAt, appVersion]);

    return jsonResponse_({ ok: true });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet() {
  return jsonResponse_({ ok: true, service: 'creative-asset-extractor-feedback' });
}

function ensureHeaders_(sheet) {
  const firstCell = String(sheet.getRange(1, 1).getValue() || '').trim();
  if (firstCell) return;
  sheet.getRange(1, 1, 1, 4).setValues([['Name', 'Suggestions', 'Submitted At', 'App Version']]);
}

function jsonResponse_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON
  );
}
