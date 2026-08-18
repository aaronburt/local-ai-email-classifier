import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { AppConfig } from './types.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

interface GoogleCredentialsFile {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

const parseRequestBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        if (!body) {
          resolvePromise({});
          return;
        }
        resolvePromise(JSON.parse(body) as Record<string, unknown>);
      } catch (err) {
        rejectPromise(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', (err) => rejectPromise(err));
  });
};

const sendJson = (res: ServerResponse, statusCode: number, data: unknown): void => {
  const payload = Buffer.from(JSON.stringify(data), 'utf-8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': payload.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
};

const sendHtml = (res: ServerResponse, statusCode: number, html: string): void => {
  const payload = Buffer.from(html, 'utf-8');
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
  });
  res.end(payload);
};

const renderSetupHtml = (initialConfig: AppConfig, port: number): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Local AI Email Classifier — Setup Wizard</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --border: #1f293d;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --error: #ef4444;
      --warning: #f59e0b;
      --font: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font);
      line-height: 1.5;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container {
      width: 100%;
      max-width: 680px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }
    .header {
      padding: 28px 32px 20px;
      border-bottom: 1px solid var(--border);
      text-align: center;
    }
    .header h1 {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 6px;
      color: #ffffff;
    }
    .header p {
      font-size: 14px;
      color: var(--text-muted);
    }
    .steps {
      display: flex;
      border-bottom: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.2);
    }
    .step-tab {
      flex: 1;
      text-align: center;
      padding: 12px 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      border-bottom: 2px solid transparent;
    }
    .step-tab.active {
      color: var(--primary);
      border-bottom-color: var(--primary);
      background: rgba(59, 130, 246, 0.05);
    }
    .step-tab.completed {
      color: var(--success);
    }
    .content {
      padding: 32px;
    }
    .step-section {
      display: none;
    }
    .step-section.active {
      display: block;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 8px;
      color: #e5e7eb;
    }
    input[type="text"], select, textarea {
      width: 100%;
      padding: 10px 14px;
      background: #0b1120;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 14px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type="text"]:focus, select:focus, textarea:focus {
      border-color: var(--primary);
    }
    .dropzone {
      border: 2px dashed var(--border);
      border-radius: 8px;
      padding: 28px;
      text-align: center;
      cursor: pointer;
      background: #0b1120;
      transition: border-color 0.2s, background-color 0.2s;
    }
    .dropzone:hover, .dropzone.dragover {
      border-color: var(--primary);
      background: rgba(59, 130, 246, 0.04);
    }
    .dropzone p {
      font-size: 14px;
      color: var(--text-muted);
      margin-top: 6px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 20px;
      background: var(--primary);
      color: white;
      font-size: 14px;
      font-weight: 600;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s;
      width: 100%;
    }
    .btn:hover {
      background: var(--primary-hover);
    }
    .btn-secondary {
      background: #1f293d;
      color: var(--text);
      margin-top: 10px;
    }
    .btn-secondary:hover {
      background: #2d3b55;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 6px;
      text-transform: uppercase;
    }
    .badge-success { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .badge-warning { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .badge-error { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .alert {
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 20px;
      display: none;
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }
    .alert-success {
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #6ee7b7;
    }
    .details-toggle {
      font-size: 13px;
      color: var(--text-muted);
      cursor: pointer;
      margin-top: 16px;
      display: block;
    }
    .footer {
      padding: 16px 32px;
      border-top: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.2);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Local AI Email Classifier</h1>
      <p>Zero-configuration first-boot setup wizard</p>
    </div>

    <div class="steps">
      <div id="tab-1" class="step-tab active">1. Credentials</div>
      <div id="tab-2" class="step-tab">2. Gmail Auth</div>
      <div id="tab-3" class="step-tab">3. Ollama & Finish</div>
    </div>

    <div class="content">
      <div id="global-alert" class="alert"></div>

      <!-- Step 1: Upload Credentials -->
      <div id="step-1" class="step-section active">
        <div class="form-group">
          <label>Google Cloud OAuth 2.0 Credentials (credentials.json)</label>
          <div id="dropzone" class="dropzone" onclick="document.getElementById('file-input').click()">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin: 0 auto; color: var(--primary);">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="17 8 12 3 7 8"></polyline>
              <line x1="12" y1="3" x2="12" y2="15"></line>
            </svg>
            <p id="dropzone-text">Click to select or drag & drop <strong>credentials.json</strong> here</p>
            <input type="file" id="file-input" accept=".json" style="display: none;" onchange="handleFileSelect(event)">
          </div>
        </div>

        <button id="btn-step-1" class="btn" onclick="saveCredentials()" disabled>Save & Proceed</button>
      </div>

      <!-- Step 2: Gmail OAuth Login -->
      <div id="step-2" class="step-section">
        <p style="font-size: 14px; color: var(--text-muted); margin-bottom: 20px;">
          Authorize the classifier to read and label emails in your inbox using Google OAuth 2.0.
        </p>

        <a id="btn-auth-redirect" href="#" class="btn" target="_blank">Sign in with Google</a>

        <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--border);">
          <label>Remote Proxmox / LXC Fallback</label>
          <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 10px;">
            If redirected to an unreachable localhost address on your client browser, paste the full redirect URL or authorization code here:
          </p>
          <input type="text" id="manual-code-input" placeholder="http://localhost:3000/oauth2callback?code=4/0A...">
          <button class="btn btn-secondary" onclick="submitManualCode()">Submit Auth Code</button>
        </div>
      </div>

      <!-- Step 3: Ollama & Finish -->
      <div id="step-3" class="step-section">
        <div class="form-group">
          <label for="ollama-host-input">Ollama Host URL</label>
          <input type="text" id="ollama-host-input" value="${initialConfig.ollama.host}">
        </div>

        <div class="form-group">
          <label for="ollama-model-select">Local Model (Tier 1)</label>
          <input type="text" id="ollama-model-select" value="${initialConfig.ollama.model}">
        </div>

        <div class="form-group">
          <label for="ollama-remote-select">Remote Escalation Model (Tier 2)</label>
          <input type="text" id="ollama-remote-select" value="${initialConfig.ollama.remoteModel}">
        </div>

        <button class="btn btn-secondary" style="margin-bottom: 20px;" onclick="testOllama()">Test Ollama Connection</button>
        <span id="ollama-test-status" style="font-size: 13px; margin-left: 8px;"></span>

        <button id="btn-finish" class="btn" onclick="finishSetup()">Complete Setup & Start Classifier</button>
      </div>
    </div>

    <div class="footer">
      <span style="font-size: 12px; color: var(--text-muted);">Port ${port}</span>
      <span id="system-status" class="badge badge-warning">Awaiting Setup</span>
    </div>
  </div>

  <script>
    let uploadedCredentials = null;

    const showAlert = (msg, isError = false) => {
      const el = document.getElementById('global-alert');
      el.textContent = msg;
      el.className = isError ? 'alert alert-error' : 'alert alert-success';
      el.style.display = 'block';
    };

    const handleFileSelect = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          uploadedCredentials = JSON.parse(event.target.result);
          document.getElementById('dropzone-text').innerHTML = 'Selected: <strong>' + file.name + '</strong>';
          document.getElementById('btn-step-1').disabled = false;
        } catch {
          showAlert('Invalid JSON file format', true);
        }
      };
      reader.readAsText(file);
    };

    const saveCredentials = async () => {
      if (!uploadedCredentials) return;
      try {
        const res = await fetch('/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(uploadedCredentials),
        });
        const data = await res.json();
        if (data.ok) {
          goToStep(2);
          loadAuthUrl();
        } else {
          showAlert(data.error || 'Failed to save credentials', true);
        }
      } catch (err) {
        showAlert('Network error saving credentials', true);
      }
    };

    const loadAuthUrl = async () => {
      try {
        const res = await fetch('/api/auth-url');
        const data = await res.json();
        if (data.url) {
          document.getElementById('btn-auth-redirect').href = data.url;
        }
      } catch {
        showAlert('Could not generate authorization URL', true);
      }
    };

    const submitManualCode = async () => {
      const input = document.getElementById('manual-code-input').value.trim();
      if (!input) return;
      try {
        const res = await fetch('/api/manual-auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codeOrUrl: input }),
        });
        const data = await res.json();
        if (data.ok) {
          goToStep(3);
        } else {
          showAlert(data.error || 'Authorization failed', true);
        }
      } catch {
        showAlert('Network error completing authorization', true);
      }
    };

    const testOllama = async () => {
      const host = document.getElementById('ollama-host-input').value.trim();
      const statusEl = document.getElementById('ollama-test-status');
      statusEl.textContent = 'Testing...';
      try {
        const res = await fetch('/api/test-ollama', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host }),
        });
        const data = await res.json();
        if (data.ok) {
          statusEl.textContent = '✓ Connected (' + (data.models?.length || 0) + ' models found)';
          statusEl.style.color = '#34d399';
        } else {
          statusEl.textContent = '✗ Connection failed';
          statusEl.style.color = '#f87171';
        }
      } catch {
        statusEl.textContent = '✗ Unreachable';
        statusEl.style.color = '#f87171';
      }
    };

    const finishSetup = async () => {
      const host = document.getElementById('ollama-host-input').value.trim();
      const model = document.getElementById('ollama-model-select').value.trim();
      const remoteModel = document.getElementById('ollama-remote-select').value.trim();
      try {
        const res = await fetch('/api/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host, model, remoteModel }),
        });
        const data = await res.json();
        if (data.ok) {
          document.querySelector('.container').innerHTML = '<div style="padding: 48px 32px; text-align: center;">' +
            '<h1 style="color: #34d399; margin-bottom: 12px;">Setup Complete!</h1>' +
            '<p style="color: #9ca3af;">All credentials and configurations have been saved to <code>/app/data/</code>.</p>' +
            '<p style="color: #9ca3af; margin-top: 8px;">The background classifier daemon is starting now. You may close this tab.</p>' +
            '</div>';
        } else {
          showAlert(data.error || 'Failed to complete setup', true);
        }
      } catch {
        showAlert('Setup complete request error', true);
      }
    };

    const goToStep = (stepNumber) => {
      document.querySelectorAll('.step-tab').forEach((tab, i) => {
        tab.className = i + 1 === stepNumber ? 'step-tab active' : (i + 1 < stepNumber ? 'step-tab completed' : 'step-tab');
      });
      document.querySelectorAll('.step-section').forEach((sec, i) => {
        sec.className = i + 1 === stepNumber ? 'step-section active' : 'step-section';
      });
      document.getElementById('global-alert').style.display = 'none';
    };

    // Check status on load
    const checkInitialStatus = async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.hasCredentials && !data.hasToken) {
          goToStep(2);
          loadAuthUrl();
        } else if (data.hasCredentials && data.hasToken) {
          goToStep(3);
        }
      } catch {}
    };

    checkInitialStatus();
  </script>
</body>
</html>`;

export const startSetupWizard = async (
  config: AppConfig,
  port = 3000
): Promise<void> => {
  return new Promise((resolveSetup) => {
    let oauthClientInstance: OAuth2Client | null = null;

    const dataDir = resolve(process.cwd(), 'data');
    const credentialsPath = resolve(dataDir, 'credentials.json');
    const tokenPath = resolve(dataDir, 'token.json');
    const configPath = resolve(dataDir, 'config.json');

    const getOAuthClient = (): OAuth2Client => {
      if (oauthClientInstance) return oauthClientInstance;
      if (!existsSync(credentialsPath)) {
        throw new Error('credentials.json is not yet uploaded');
      }
      const fileContent = readFileSync(credentialsPath, 'utf-8');
      const credentials = JSON.parse(fileContent) as GoogleCredentialsFile;
      const creds = credentials.installed ?? credentials.web;
      if (!creds) throw new Error('Invalid credentials format');

      const redirectUri = `http://localhost:${port}/oauth2callback`;
      oauthClientInstance = new google.auth.OAuth2(creds.client_id, creds.client_secret, redirectUri);
      return oauthClientInstance;
    };

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        const pathname = url.pathname;

        if (pathname === '/') {
          sendHtml(res, 200, renderSetupHtml(config, port));
          return;
        }

        if (pathname === '/api/status') {
          sendJson(res, 200, {
            hasCredentials: existsSync(credentialsPath),
            hasToken: existsSync(tokenPath),
            hasConfig: existsSync(configPath),
          });
          return;
        }

        if (pathname === '/api/credentials' && req.method === 'POST') {
          try {
            const body = await parseRequestBody(req);
            const creds = (body['installed'] ?? body['web']) as Record<string, unknown> | undefined;
            if (!creds || !creds['client_id'] || !creds['client_secret']) {
              sendJson(res, 400, { ok: false, error: 'Invalid credentials.json: missing client_id or client_secret' });
              return;
            }
            writeFileSync(credentialsPath, JSON.stringify(body, null, 2), 'utf-8');
            oauthClientInstance = null;
            sendJson(res, 200, { ok: true });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'Upload failed' });
          }
          return;
        }

        if (pathname === '/api/auth-url') {
          try {
            const client = getOAuthClient();
            const authUrl = client.generateAuthUrl({
              access_type: 'offline',
              scope: SCOPES,
              prompt: 'consent',
            });
            sendJson(res, 200, { url: authUrl });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : 'Failed to generate auth URL' });
          }
          return;
        }

        if (pathname === '/oauth2callback') {
          const code = url.searchParams.get('code');
          if (!code) {
            sendHtml(res, 400, '<h1>Missing authorization code</h1>');
            return;
          }
          try {
            const client = getOAuthClient();
            const { tokens } = await client.getToken(code);
            writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), 'utf-8');
            sendHtml(res, 200, '<script>window.opener ? window.opener.location.reload() : (window.location.href="/");</script><h1>Authenticated!</h1><p>Returning to setup...</p>');
          } catch (err) {
            sendHtml(res, 500, '<h1>Authentication Failed</h1><p>' + (err instanceof Error ? err.message : 'Unknown error') + '</p>');
          }
          return;
        }

        if (pathname === '/api/manual-auth' && req.method === 'POST') {
          try {
            const body = await parseRequestBody(req);
            const codeOrUrl = String(body['codeOrUrl'] ?? '').trim();
            let code = codeOrUrl;
            if (codeOrUrl.includes('code=')) {
              const parsed = new URL(codeOrUrl.startsWith('http') ? codeOrUrl : `http://localhost?${codeOrUrl}`);
              code = parsed.searchParams.get('code') ?? codeOrUrl;
            }
            const client = getOAuthClient();
            const { tokens } = await client.getToken(code);
            writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), 'utf-8');
            sendJson(res, 200, { ok: true });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'Invalid code' });
          }
          return;
        }

        if (pathname === '/api/test-ollama' && req.method === 'POST') {
          try {
            const body = await parseRequestBody(req);
            const host = String(body['host'] ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
            const response = await fetch(`${host}/api/tags`);
            if (!response.ok) {
              sendJson(res, 502, { ok: false });
              return;
            }
            const data = (await response.json()) as { models?: Array<{ name: string }> };
            sendJson(res, 200, { ok: true, models: data.models?.map((m) => m.name) ?? [] });
          } catch {
            sendJson(res, 502, { ok: false });
          }
          return;
        }

        if (pathname === '/api/complete' && req.method === 'POST') {
          try {
            const body = await parseRequestBody(req);
            const newConfig = {
              ...config,
              ollama: {
                ...config.ollama,
                host: String(body['host'] ?? config.ollama.host),
                model: String(body['model'] ?? config.ollama.model),
                remoteModel: String(body['remoteModel'] ?? config.ollama.remoteModel),
              },
            };
            writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf-8');
            sendJson(res, 200, { ok: true });

            setTimeout(() => {
              clearInterval(poller);
              server.close();
              resolveSetup();
            }, 1000);
          } catch (err) {
            sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : 'Failed to save config' });
          }
          return;
        }

        sendJson(res, 404, { error: 'Not found' });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : 'Internal server error' });
      }
    });

    const poller = setInterval(() => {
      if (existsSync(credentialsPath) && existsSync(tokenPath)) {
        clearInterval(poller);
        server.close();
        resolveSetup();
      }
    }, 2000);

    server.listen(port, '0.0.0.0', () => {
      process.stdout.write(
        `\n\x1b[33m========================================================================\x1b[0m\n` +
        `\x1b[33;1m[SETUP REQUIRED]\x1b[0m First-time setup detected.\n` +
        `Please open the Web Setup Wizard in your browser to complete onboarding:\n\n` +
        `  👉 \x1b[36;1mhttp://localhost:${port}\x1b[0m (or http://<your-server-ip>:${port})\n\n` +
        `Waiting for setup completion or file drop in ./data/...\n` +
        `\x1b[33m========================================================================\x1b[0m\n\n`
      );
    });
  });
};
