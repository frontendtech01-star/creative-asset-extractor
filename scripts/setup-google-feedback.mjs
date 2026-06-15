import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const scriptId = '1pWq4lSi0V_HgrfxGuHZrYOYKqSOTHjkiNZ6LCqQAxoR-peG2XHuZnrlX';
const sheetId = '1dxhHtdi06oOwh-9d-ZdMxo8Wa7LIYJBu7lWXTsaP2xI';
const claspRcPath = path.join(os.homedir(), '.clasprc.json');
const feedbackConfigPath = path.join(os.homedir(), '.creative-asset-extractor', 'feedback-config.json');
const envPath = path.join(projectRoot, '.env');

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });

const readClaspToken = async () => {
  const raw = await fs.readFile(claspRcPath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed?.tokens?.access_token || '';
};

const claspFetch = async (pathname, init = {}) => {
  const token = await readClaspToken();
  if (!token) throw new Error('Missing clasp access token. Run: npx @google/clasp login');
  const response = await fetch(`https://script.googleapis.com/v1${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.error?.message || text || `Apps Script API ${response.status}`);
  }
  return data;
};

const webhookUrlForDeployment = (deploymentId) =>
  `https://script.google.com/macros/s/${deploymentId}/exec`;

const writeConfig = async (webhookUrl) => {
  await fs.mkdir(path.dirname(feedbackConfigPath), { recursive: true });
  await fs.writeFile(
    feedbackConfigPath,
    `${JSON.stringify({ sheetId, sheetWebhookUrl: webhookUrl }, null, 2)}\n`,
    'utf8'
  );

  const envLines = [
    `GOOGLE_SHEET_ID=${sheetId}`,
    `GOOGLE_SHEET_FEEDBACK_WEBHOOK_URL=${webhookUrl}`,
    '',
  ];
  await fs.writeFile(envPath, envLines.join('\n'), 'utf8');
};

const testWebhook = async (webhookUrl) => {
  const payload = {
    name: 'Creative Asset Extractor Setup',
    suggestions: `Webhook test at ${new Date().toISOString()}`,
    submittedAt: new Date().toISOString(),
    appVersion: '1.0.0',
  };
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const hint =
      response.status === 404
        ? ' This usually means the Apps Script is saved but not deployed as a Web app yet (Deploy → New deployment → Web app, Access: Anyone). Copy the full Web app URL from that dialog — not the Head/version ID.'
        : '';
    throw new Error((data?.error || `Webhook test failed with status ${response.status}`) + hint);
  }
};

const deployWebhook = async () => {
  console.log('Pushing Apps Script project...');
  await run('npx', ['@google/clasp', 'push', '-f']);

  console.log('Creating Apps Script version...');
  const version = await claspFetch(`/projects/${scriptId}/versions`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  console.log('Creating web app deployment...');
  const deployment = await claspFetch(`/projects/${scriptId}/deployments`, {
    method: 'POST',
    body: JSON.stringify({
      versionNumber: version.versionNumber,
      description: 'Creative Asset Extractor feedback webhook',
      manifestFileName: 'appsscript',
      deploymentConfig: {
        webApp: {
          access: 'ANYONE',
          executeAs: 'USER_DEPLOYING',
        },
      },
    }),
  });

  const deploymentId = String(deployment?.deploymentId || '').trim();
  if (!deploymentId) throw new Error('Deployment succeeded but no deploymentId was returned.');
  return webhookUrlForDeployment(deploymentId);
};

const main = async () => {
  const webhookArg = process.argv.find((arg) => arg.startsWith('--webhook-url='));
  const webhookFromArg = webhookArg ? webhookArg.split('=').slice(1).join('=').trim() : '';
  const forceSave = process.argv.includes('--force');

  if (webhookFromArg) {
    console.log('Saving provided webhook URL...');
    await writeConfig(webhookFromArg);
    console.log('Testing webhook...');
    try {
      await testWebhook(webhookFromArg);
    } catch (error) {
      if (!forceSave) throw error;
      console.warn(`Webhook test failed, saving anyway because --force was used: ${error?.message || error}`);
    }
    console.log('Feedback webhook URL saved.');
    console.log(`Config: ${feedbackConfigPath}`);
    console.log(`Env: ${envPath}`);
    return;
  }

  const hasClaspCreds = await fs.access(claspRcPath).then(() => true).catch(() => false);
  if (!hasClaspCreds) {
    console.log('Google login required once to deploy the webhook automatically.');
    console.log('A browser window will open — sign in with the Google account that owns the sheet.');
    await run('npx', ['@google/clasp', 'login', '--no-localhost']);
  }

  const webhookUrl = await deployWebhook();
  console.log(`Webhook URL: ${webhookUrl}`);
  await writeConfig(webhookUrl);
  console.log('Testing webhook...');
  await testWebhook(webhookUrl);
  console.log('Feedback webhook deployed, saved, and verified.');
  console.log(`Sheet: https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
  console.log(`Config: ${feedbackConfigPath}`);
  console.log(`Env: ${envPath}`);
  console.log('Restart the app with: npm run dev');
};

main().catch((error) => {
  console.error('\nSetup failed:', error?.message || error);
  console.error('\nManual fallback:');
  console.error('1. Open your Apps Script project and click Deploy → New deployment → Web app');
  console.error('2. Run: npm run setup:feedback -- --webhook-url=YOUR_WEB_APP_URL');
  process.exit(1);
});
