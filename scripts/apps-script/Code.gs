/**
 * Creative Asset Extractor — feedback webhook for Google Sheets.
 * After editing, redeploy: Deploy → Manage deployments → Edit → New version.
 */
var FEEDBACK_SHEET_VERSION = 6;

var FEEDBACK_HEADERS = [
  'Name',
  'Category',
  'Website URL',
  'Video URL',
  'Font Name',
  'Screenshot',
  'Suggestions',
  'App Version',
  'Platform',
  'OS',
  'Architecture',
  'Last Error',
  'Submitted At',
];

var SCREENSHOT_COLUMN = 6;
var SCREENSHOT_CELL_WIDTH = 240;
var SCREENSHOT_CELL_HEIGHT = 150;

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const name = String(payload.name || '').trim();
    const category = String(payload.category || 'Suggestion').trim();
    const suggestions = String(payload.suggestions || '').trim();
    const websiteUrl = String(payload.websiteUrl || '').trim();
    const videoUrl = String(payload.videoUrl || '').trim();
    const fontName = String(payload.fontName || '').trim();
    const screenshotUrl = String(payload.screenshotUrl || '').trim();
    const lastError = String(payload.lastError || '').trim();
    const submittedAt = String(payload.submittedAt || new Date().toISOString());
    const appVersion = String(payload.appVersion || '').trim();
    const platform = String(payload.platform || '').trim();
    const osLabel = String(payload.osLabel || '').trim();
    const architecture = String(payload.architecture || '').trim();

    if (!name || !suggestions) {
      return jsonResponse_({ ok: false, error: 'Name and suggestions are required.' });
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    ensureHeaders_(sheet);
    sheet.appendRow([
      name,
      category,
      websiteUrl,
      videoUrl,
      fontName,
      '',
      suggestions,
      appVersion,
      platform,
      osLabel,
      architecture,
      lastError,
      submittedAt,
    ]);

    const rowNum = sheet.getLastRow();
    applyScreenshotToRow_(sheet, rowNum, payload, screenshotUrl);

    return jsonResponse_({ ok: true, version: FEEDBACK_SHEET_VERSION });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet() {
  return jsonResponse_({
    ok: true,
    service: 'creative-asset-extractor-feedback',
    version: FEEDBACK_SHEET_VERSION,
    columns: FEEDBACK_HEADERS.length,
  });
}

function applyScreenshotToRow_(sheet, rowNum, payload, screenshotUrl) {
  const screenshotBase64 = String(payload.screenshotBase64 || '').trim();
  const cell = sheet.getRange(rowNum, SCREENSHOT_COLUMN);

  if (!screenshotBase64) {
    if (screenshotUrl) cell.setValue(screenshotUrl);
    return;
  }

  try {
    ensureScreenshotColumnSize_(sheet);
    sheet.setRowHeight(rowNum, SCREENSHOT_CELL_HEIGHT);
    const screenshotMimeType = String(payload.screenshotMimeType || 'image/png').trim();
    const bytes = Utilities.base64Decode(screenshotBase64);
    const blob = Utilities.newBlob(bytes, screenshotMimeType, 'feedback-screenshot.png');
    sheet.insertImage(blob, SCREENSHOT_COLUMN, rowNum);
    const images = sheet.getImages();
    const image = images.length ? images[images.length - 1] : null;
    fitImageToCell_(image, SCREENSHOT_CELL_WIDTH, SCREENSHOT_CELL_HEIGHT);
  } catch (err) {
    cell.setValue('Screenshot failed: ' + String(err && err.message ? err.message : err));
  }
}

function ensureScreenshotColumnSize_(sheet) {
  if (sheet.getColumnWidth(SCREENSHOT_COLUMN) !== SCREENSHOT_CELL_WIDTH) {
    sheet.setColumnWidth(SCREENSHOT_COLUMN, SCREENSHOT_CELL_WIDTH);
  }
}

function fitImageToCell_(image, maxWidth, maxHeight) {
  if (!image) return;
  try {
    const width = image.getWidth();
    const height = image.getHeight();
    if (width > 0 && height > 0) {
      const scale = Math.min(maxWidth / width, maxHeight / height, 1);
      image.setWidth(Math.max(1, Math.round(width * scale)));
      image.setHeight(Math.max(1, Math.round(height * scale)));
      return;
    }
  } catch (err) {
    // Fall back to fixed cell size below.
  }
  try {
    image.setWidth(maxWidth);
    image.setHeight(maxHeight);
  } catch (err2) {
    // Keep the inserted image at its default size.
  }
}

function ensureHeaders_(sheet) {
  const width = FEEDBACK_HEADERS.length;
  const lastCol = Math.max(sheet.getLastColumn(), width);
  const current = sheet
    .getRange(1, 1, 1, lastCol)
    .getValues()[0]
    .map(function (value) {
      return String(value || '').trim();
    });

  const matches =
    current.length >= width &&
    FEEDBACK_HEADERS.every(function (header, index) {
      return current[index] === header;
    });

  if (matches) return;

  sheet.getRange(1, 1, 1, width).setValues([FEEDBACK_HEADERS]);
  sheet.getRange(1, 1, 1, width).setFontWeight('bold');
}

function jsonResponse_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON
  );
}
