import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { AppConfig, LearnedRule, LearnedStyleProfile, PendingSmartReply, UnmatchedEmailRecord } from './types.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const MAX_LOG_LINES = 500;

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

export interface WebServerState {
  isSetup: boolean;
  isClassifying: boolean;
  model: string;
  remoteModel?: string;
  cronSchedule: string;
  lastRunTime?: string;
  totalProcessed: number;
}

const logBuffer: string[] = [];
const sseClients = new Set<ServerResponse>();

const resolveDataPath = (fileName: string, explicitPath?: string): string => {
  const targetName = explicitPath ?? fileName;
  if (targetName.startsWith('/') || /^[a-zA-Z]:/.test(targetName)) {
    return targetName;
  }
  const dataSubpath = `${process.cwd()}/data/${targetName}`;
  if (existsSync(dataSubpath)) {
    return dataSubpath;
  }
  const rootPath = `${process.cwd()}/${targetName}`;
  if (existsSync(rootPath)) {
    return rootPath;
  }
  if (existsSync(`${process.cwd()}/data`)) {
    return dataSubpath;
  }
  return rootPath;
};

export const appendWebLog = (rawLine: string): void => {
  const line = rawLine.trim();
  if (!line) return;
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer.shift();
  }

  const sseData = `data: ${JSON.stringify({ log: line, timestamp: new Date().toISOString() })}\n\n`;
  for (const client of sseClients) {
    if (client.destroyed || client.writableEnded) {
      sseClients.delete(client);
      continue;
    }
    try {
      client.write(sseData, (err) => {
        if (err) {
          sseClients.delete(client);
        }
      });
    } catch {
      sseClients.delete(client);
    }
  }
};

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
      } catch {
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

const isAuthorized = (req: IncomingMessage): boolean => {
  const configuredPassword = process.env['WEB_PASSWORD'];
  if (!configuredPassword || configuredPassword.trim().length === 0) {
    return true;
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7) === configuredPassword;
  }

  const cookie = req.headers.cookie;
  if (cookie) {
    const match = cookie.match(/auth_token=([^;]+)/);
    if (match && match[1] === configuredPassword) {
      return true;
    }
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const tokenParam = url.searchParams.get('token');
  return tokenParam === configuredPassword;
};

const renderAppHtml = (state: WebServerState, hasPasswordAuth: boolean): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Local AI Email Classifier</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --surface-subtle: #21262d;
      --surface-hover: #1f242c;
      --border: #30363d;
      --border-muted: #21262d;
      --text: #e6edf3;
      --text-muted: #848d97;
      --accent: #2f81f7;
      --accent-hover: #388bfd;
      --accent-subtle: rgba(56, 139, 253, 0.15);
      --success: #3fb950;
      --warning: #d29922;
      --error: #f85149;
      --code-bg: #090d12;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 13px;
      line-height: 1.45;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    header {
      background-color: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 10px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }
    .app-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      letter-spacing: -0.01em;
    }
    .meta-tags {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .meta-tag {
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      padding: 2px 7px;
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 11px;
    }
    .status-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--success);
      margin-right: 4px;
    }
    .status-dot.busy {
      background: var(--warning);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn {
      background-color: #238636;
      color: #ffffff;
      border: 1px solid rgba(240, 246, 252, 0.1);
      border-radius: 5px;
      padding: 5px 11px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-family: inherit;
      transition: background 0.1s;
    }
    .btn:hover:not(:disabled) {
      background-color: #2ea043;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-secondary {
      background-color: var(--surface-subtle);
      border: 1px solid var(--border);
      color: var(--text);
    }
    .btn-secondary:hover:not(:disabled) {
      background-color: #30363d;
    }
    .btn-danger {
      background-color: transparent;
      border: 1px solid var(--border);
      color: var(--error);
    }
    .btn-danger:hover:not(:disabled) {
      background-color: rgba(248, 81, 73, 0.1);
      border-color: var(--error);
    }

    .nav-bar {
      background-color: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 0 16px;
      display: flex;
      gap: 2px;
    }
    .nav-tab {
      padding: 9px 12px;
      font-size: 12.5px;
      font-weight: 500;
      color: var(--text-muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: color 0.1s;
      user-select: none;
    }
    .nav-tab:hover {
      color: var(--text);
    }
    .nav-tab.active {
      color: var(--text);
      border-bottom-color: var(--accent);
    }
    .tab-count {
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      padding: 1px 5px;
      border-radius: 10px;
      font-size: 11px;
      font-family: var(--font-mono);
    }

    main {
      flex: 1;
      padding: 16px;
      max-width: 1400px;
      width: 100%;
      margin: 0 auto;
    }
    .tab-pane {
      display: none;
    }
    .tab-pane.active {
      display: block;
    }

    .terminal-container {
      background-color: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      display: flex;
      flex-direction: column;
      height: calc(100vh - 150px);
      min-height: 480px;
    }
    .terminal-toolbar {
      background-color: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 6px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      gap: 12px;
    }
    .search-input {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 3px 8px;
      color: var(--text);
      font-size: 12px;
      font-family: inherit;
      outline: none;
      width: 220px;
    }
    .search-input:focus {
      border-color: var(--accent);
    }
    .terminal-output {
      flex: 1;
      padding: 12px 14px;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.55;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .log-row {
      margin-bottom: 1px;
    }
    .log-info { color: #79c0ff; }
    .log-success { color: #56d364; }
    .log-warn { color: #e3b341; }
    .log-error { color: #ff7b72; }

    .control-banner {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 12.5px;
    }

    .reply-item {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px;
      margin-bottom: 12px;
    }
    .reply-item-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 8px;
    }
    .reply-subject {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--text);
    }
    .reply-meta {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .snippet-preview {
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px 10px;
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 10px;
    }
    .editor-textarea {
      width: 100%;
      min-height: 100px;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 9px 10px;
      color: var(--text);
      font-family: inherit;
      font-size: 12.5px;
      line-height: 1.5;
      resize: vertical;
      outline: none;
      margin-bottom: 10px;
    }
    .editor-textarea:focus {
      border-color: var(--accent);
    }
    .reply-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }

    .data-table-wrap {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th {
      background: var(--surface-subtle);
      border-bottom: 1px solid var(--border);
      padding: 8px 12px;
      text-align: left;
      font-weight: 600;
      color: var(--text-muted);
    }
    td {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-muted);
      vertical-align: top;
    }
    tr:last-child td {
      border-bottom: none;
    }
    tr:hover td {
      background: var(--surface-hover);
    }
    code {
      font-family: var(--font-mono);
      font-size: 11.5px;
      background: var(--surface-subtle);
      padding: 2px 4px;
      border-radius: 3px;
    }
    .label-pill {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: 500;
      background: var(--accent-subtle);
      color: #58a6ff;
      border: 1px solid rgba(56, 139, 253, 0.3);
    }

    #auth-overlay {
      position: fixed;
      inset: 0;
      background: rgba(13, 17, 23, 0.95);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .auth-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 24px;
      width: 100%;
      max-width: 320px;
    }
    .auth-input {
      width: 100%;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 7px 10px;
      color: var(--text);
      font-size: 13px;
      margin: 12px 0;
      outline: none;
    }
    .auth-input:focus {
      border-color: var(--accent);
    }
  </style>
</head>
<body>
  ${hasPasswordAuth ? `
  <div id="auth-overlay">
    <div class="auth-box">
      <div style="font-weight: 600; margin-bottom: 4px;">Authentication Required</div>
      <div style="color: var(--text-muted); font-size: 12px;">Enter your WEB_PASSWORD:</div>
      <input type="password" id="auth-pwd-input" class="auth-input" placeholder="Password" onkeydown="if(event.key==='Enter') submitAuth()">
      <button class="btn" style="width: 100%; justify-content: center;" onclick="submitAuth()">Unlock</button>
      <div id="auth-error" style="color: var(--error); font-size: 11px; margin-top: 8px; display: none;">Invalid password</div>
    </div>
  </div>` : ''}

  <header>
    <div class="header-left">
      <div class="app-title">local-ai-email-classifier</div>
      <div class="meta-tags">
        <span class="meta-tag"><span id="status-dot" class="status-dot"></span><span id="stat-status">Idle</span></span>
        <span class="meta-tag">Model: <code>${state.model}</code></span>
        ${state.remoteModel ? `<span class="meta-tag">Remote: <code>${state.remoteModel}</code></span>` : ''}
        <span class="meta-tag">Cron: <code>${state.cronSchedule}</code></span>
      </div>
    </div>

    <div class="header-actions">
      <button id="btn-run" class="btn" onclick="triggerRun()">Run Classification Pass</button>
      <button id="btn-cull" class="btn btn-secondary" onclick="cullMemory()">Unload Model</button>
    </div>
  </header>

  <div class="nav-bar">
    <div class="nav-tab active" onclick="switchTab('logs')">Live Logs</div>
    <div class="nav-tab" onclick="switchTab('replies')">Smart Replies <span id="reply-count" class="tab-count">0</span></div>
    <div class="nav-tab" onclick="switchTab('rules')">Learned Rules <span id="rule-count" class="tab-count">0</span></div>
    <div class="nav-tab" onclick="switchTab('unmatched')">Unmatched Queue <span id="unmatched-count" class="tab-count">0</span></div>
  </div>

  <main>
    <!-- Tab 1: Live Logs -->
    <div id="pane-logs" class="tab-pane active">
      <div class="terminal-container">
        <div class="terminal-toolbar">
          <div style="display: flex; align-items: center; gap: 8px;">
            <input type="text" id="log-filter" class="search-input" placeholder="Filter output..." oninput="filterLogs()">
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <label style="cursor: pointer; display: flex; align-items: center; gap: 4px; user-select: none;">
              <input type="checkbox" id="auto-scroll-chk" checked> Auto-scroll
            </label>
            <button class="btn btn-secondary" style="padding: 2px 7px; font-size: 11px;" onclick="clearLogs()">Clear</button>
          </div>
        </div>
        <div id="terminal-output" class="terminal-output"></div>
      </div>
    </div>

    <!-- Tab 2: Smart Replies -->
    <div id="pane-replies" class="tab-pane">
      <div class="control-banner">
        <div>
          <span style="font-weight: 600; color: var(--text);">Style Profile: </span>
          <span id="style-summary" style="color: var(--text-muted);">Loading profile...</span>
        </div>
        <button id="btn-learn-style" class="btn btn-secondary" onclick="learnStyle()">Re-analyze Sent Mail</button>
      </div>

      <div id="replies-list">
        <div style="text-align: center; padding: 32px; color: var(--text-muted);">No pending smart replies.</div>
      </div>
    </div>

    <!-- Tab 3: Learned Rules -->
    <div id="pane-rules" class="tab-pane">
      <div style="margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
        <input type="text" id="rules-filter" class="search-input" placeholder="Filter rules by domain or label..." oninput="filterRules()" style="width: 300px;">
        <span id="rules-filter-count" style="font-size: 12px; color: var(--text-muted);"></span>
      </div>
      <div class="data-table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width: 22%;">Domain</th>
              <th style="width: 15%;">Target Label</th>
              <th style="width: 28%;">Condition</th>
              <th style="width: 35%;">Reasoning</th>
            </tr>
          </thead>
          <tbody id="rules-tbody">
            <tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 24px;">Loading rules...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab 4: Unmatched Queue -->
    <div id="pane-unmatched" class="tab-pane">
      <div class="data-table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width: 28%;">Subject</th>
              <th style="width: 22%;">Sender</th>
              <th style="width: 10%;">Confidence</th>
              <th style="width: 40%;">Reasoning</th>
            </tr>
          </thead>
          <tbody id="unmatched-tbody">
            <tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 24px;">Loading unmatched queue...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <script>
    let autoscroll = true;
    let rawLogLines = [];
    let cachedRules = [];
    const terminalEl = document.getElementById('terminal-output');
    const autoScrollChk = document.getElementById('auto-scroll-chk');

    autoScrollChk.addEventListener('change', (e) => {
      autoscroll = e.target.checked;
    });

    const formatLogLine = (text) => {
      let colorClass = 'log-row';
      if (text.includes('[SUCCESS]')) colorClass += ' log-success';
      else if (text.includes('[ERROR]')) colorClass += ' log-error';
      else if (text.includes('[WARN]')) colorClass += ' log-warn';
      else if (text.includes('[INFO]')) colorClass += ' log-info';

      const cleanText = text
        .replace(/\\x1b\\[[0-9;]*m/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      return '<div class="' + colorClass + '">' + cleanText + '</div>';
    };

    const appendLogToView = (text) => {
      rawLogLines.push(text);
      if (rawLogLines.length > 1000) rawLogLines.shift();

      const filterVal = document.getElementById('log-filter').value.toLowerCase().trim();
      if (!filterVal || text.toLowerCase().includes(filterVal)) {
        terminalEl.innerHTML += formatLogLine(text);
        if (autoscroll) {
          terminalEl.scrollTop = terminalEl.scrollHeight;
        }
      }
    };

    const filterLogs = () => {
      const filterVal = document.getElementById('log-filter').value.toLowerCase().trim();
      terminalEl.innerHTML = rawLogLines
        .filter(l => !filterVal || l.toLowerCase().includes(filterVal))
        .map(formatLogLine)
        .join('');
      if (autoscroll) {
        terminalEl.scrollTop = terminalEl.scrollHeight;
      }
    };

    const clearLogs = () => {
      rawLogLines = [];
      terminalEl.innerHTML = '';
    };

    const switchTab = (tabName) => {
      document.querySelectorAll('.nav-tab').forEach((t, i) => {
        const isSelected = (tabName === 'logs' && i === 0) || (tabName === 'replies' && i === 1) || (tabName === 'rules' && i === 2) || (tabName === 'unmatched' && i === 3);
        t.className = isSelected ? 'nav-tab active' : 'nav-tab';
      });
      document.querySelectorAll('.tab-pane').forEach((tc) => tc.classList.remove('active'));
      document.getElementById('pane-' + tabName).classList.add('active');

      if (tabName === 'replies') { loadReplies(); loadStyleProfile(); }
      if (tabName === 'rules') loadRules();
      if (tabName === 'unmatched') loadUnmatched();
    };

    const initLogStream = () => {
      const source = new EventSource('/api/logs/stream');
      source.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.log) appendLogToView(data.log);
        } catch {}
      };
      source.onerror = () => {
        setTimeout(initLogStream, 3000);
      };
    };

    const triggerRun = async () => {
      const btn = document.getElementById('btn-run');
      btn.disabled = true;
      btn.textContent = 'Running...';
      document.getElementById('stat-status').textContent = 'Classifying';
      document.getElementById('status-dot').className = 'status-dot busy';

      try {
        const res = await fetch('/api/trigger-run', { method: 'POST' });
        const data = await res.json();
        if (!data.ok) alert(data.error || 'Failed to trigger run');
      } catch (err) {
        alert('Network error triggering run');
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = 'Run Classification Pass';
          document.getElementById('stat-status').textContent = 'Idle';
          document.getElementById('status-dot').className = 'status-dot';
        }, 3000);
      }
    };

    const cullMemory = async () => {
      const btn = document.getElementById('btn-cull');
      btn.disabled = true;
      try {
        const res = await fetch('/api/cull-memory', { method: 'POST' });
        const data = await res.json();
        if (data.ok) appendLogToView('[INFO] Memory culled: Ollama model unloaded from RAM.');
      } catch {}
      finally {
        btn.disabled = false;
      }
    };

    const loadRules = async () => {
      try {
        const res = await fetch('/api/rules');
        const data = await res.json();
        cachedRules = data.rules || [];
        document.getElementById('rule-count').textContent = cachedRules.length;
        renderRules(cachedRules);
      } catch {}
    };

    const renderRules = (rules) => {
      const tbody = document.getElementById('rules-tbody');
      document.getElementById('rules-filter-count').textContent = 'Showing ' + rules.length + ' rules';
      if (rules.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 24px;">No rules found</td></tr>';
        return;
      }
      tbody.innerHTML = rules.map(r => '<tr>' +
        '<td><code>' + (r.senderDomain || '-') + '</code></td>' +
        '<td><span class="label-pill">' + (r.targetLabel || '-') + '</span></td>' +
        '<td style="color: var(--text);">' + (r.topicCondition || '-') + '</td>' +
        '<td style="color: var(--text-muted);">' + (r.reasoning || '-') + '</td>' +
        '</tr>').join('');
    };

    const filterRules = () => {
      const query = document.getElementById('rules-filter').value.toLowerCase().trim();
      const filtered = cachedRules.filter(r => 
        !query ||
        (r.senderDomain && r.senderDomain.toLowerCase().includes(query)) ||
        (r.targetLabel && r.targetLabel.toLowerCase().includes(query)) ||
        (r.topicCondition && r.topicCondition.toLowerCase().includes(query))
      );
      renderRules(filtered);
    };

    const loadUnmatched = async () => {
      try {
        const res = await fetch('/api/unmatched');
        const data = await res.json();
        const tbody = document.getElementById('unmatched-tbody');
        const list = data.unmatched || [];
        document.getElementById('unmatched-count').textContent = list.length;
        if (list.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 24px;">Queue is empty</td></tr>';
          return;
        }
        tbody.innerHTML = list.map(u => '<tr>' +
          '<td><strong>' + (u.subject || 'No Subject') + '</strong></td>' +
          '<td><code>' + (u.sender || 'Unknown') + '</code></td>' +
          '<td><code>' + (u.confidence || '0.00') + '</code></td>' +
          '<td style="color: var(--text-muted);">' + (u.reasoning || '-') + '</td>' +
          '</tr>').join('');
      } catch {}
    };

    const loadStyleProfile = async () => {
      try {
        const res = await fetch('/api/style-profile');
        const data = await res.json();
        if (data.profile) {
          const p = data.profile;
          document.getElementById('style-summary').innerHTML = '<strong>' + (p.tone || 'Direct') + '</strong> &bull; Avg ~' + (p.averageLengthWords || 40) + ' words';
        }
      } catch {}
    };

    const learnStyle = async () => {
      const btn = document.getElementById('btn-learn-style');
      btn.disabled = true;
      btn.textContent = 'Analyzing...';
      try {
        const res = await fetch('/api/learn-style', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          loadStyleProfile();
          appendLogToView('[SUCCESS] Style profile updated from sent emails.');
        } else {
          alert(data.error || 'Failed to learn style');
        }
      } catch (err) {
        alert('Error learning style profile');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Re-analyze Sent Mail';
      }
    };

    const loadReplies = async () => {
      try {
        const res = await fetch('/api/smart-replies');
        const data = await res.json();
        const listEl = document.getElementById('replies-list');
        const replies = data.replies || [];
        document.getElementById('reply-count').textContent = replies.length;

        if (replies.length === 0) {
          listEl.innerHTML = '<div style="text-align: center; padding: 32px; color: var(--text-muted); background: var(--surface); border: 1px solid var(--border); border-radius: 6px;">No pending smart replies.</div>';
          return;
        }

        listEl.innerHTML = replies.map(r => '<div class="reply-item" id="reply-card-' + r.id + '">' +
          '<div class="reply-item-header">' +
            '<div>' +
              '<div class="reply-subject">' + (r.subject || 'No Subject') + '</div>' +
              '<div class="reply-meta">From: <code>' + (r.sender || 'Unknown') + '</code> &bull; ' + (r.receivedAt || '') + '</div>' +
            '</div>' +
            '<span class="meta-tag">' + Math.round((r.confidence || 0) * 100) + '% match</span>' +
          '</div>' +
          '<div class="snippet-preview">' + (r.originalSnippet || '') + '</div>' +
          '<textarea id="draft-text-' + r.id + '" class="editor-textarea">' + (r.suggestedReply || '') + '</textarea>' +
          '<div class="reply-footer">' +
            '<div style="display: flex; gap: 8px;">' +
              '<button class="btn" id="btn-save-' + r.id + '" onclick="saveDraft(\\'' + r.id + '\\')">Save as Gmail Draft</button>' +
              '<button class="btn btn-secondary" onclick="dismissReply(\\'' + r.id + '\\')">Dismiss</button>' +
            '</div>' +
            '<span style="font-size: 11.5px; color: var(--text-muted);">' + (r.reasoning || '') + '</span>' +
          '</div>' +
        '</div>').join('');
      } catch {}
    };

    const saveDraft = async (id) => {
      const btn = document.getElementById('btn-save-' + id);
      const text = document.getElementById('draft-text-' + id).value;
      btn.disabled = true;
      btn.textContent = 'Saving...';

      try {
        const res = await fetch('/api/save-draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, body: text })
        });
        const data = await res.json();
        if (data.ok) {
          btn.className = 'btn btn-secondary';
          btn.textContent = 'Saved to Gmail Drafts';
          setTimeout(() => {
            document.getElementById('reply-card-' + id)?.remove();
            loadReplies();
          }, 800);
        } else {
          alert(data.error || 'Failed to save draft');
          btn.disabled = false;
          btn.textContent = 'Save as Gmail Draft';
        }
      } catch (err) {
        alert('Network error saving draft');
        btn.disabled = false;
        btn.textContent = 'Save as Gmail Draft';
      }
    };

    const dismissReply = async (id) => {
      try {
        await fetch('/api/dismiss-reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        document.getElementById('reply-card-' + id)?.remove();
        loadReplies();
      } catch {}
    };

    const submitAuth = async () => {
      const input = document.getElementById('auth-pwd-input').value;
      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: input })
        });
        const data = await res.json();
        if (data.ok) {
          document.cookie = 'auth_token=' + encodeURIComponent(input) + '; path=/; max-age=2592000';
          document.getElementById('auth-overlay').style.display = 'none';
        } else {
          document.getElementById('auth-error').style.display = 'block';
        }
      } catch {
        document.getElementById('auth-error').style.display = 'block';
      }
    };

    initLogStream();
    loadReplies();
    loadRules();
    loadUnmatched();
  </script>
</body>
</html>`;

export const startPersistentWebServer = (options: {
  config: AppConfig;
  port?: number;
  onTriggerRun?: () => Promise<void>;
  onCullMemory?: () => Promise<void>;
  onLearnStyle?: () => Promise<LearnedStyleProfile>;
  onSaveDraft?: (options: { id: string; body: string }) => Promise<void>;
}): http.Server => {
  const port = options.port ?? options.config.gmail.oauthPort ?? 3000;
  const config = options.config;
  let oAuth2ClientInstance: OAuth2Client | null = null;

  const serverState: WebServerState = {
    isSetup: existsSync(config.gmail.credentialsPath) && existsSync(config.gmail.tokenPath),
    isClassifying: false,
    model: config.ollama.model,
    remoteModel: config.ollama.remoteModel,
    cronSchedule: process.env['CRON_SCHEDULE'] ?? '*/5 * * * *',
    totalProcessed: 0,
  };

  const getOAuthClient = (credentialsData: GoogleCredentialsFile, customPort = port): OAuth2Client => {
    const keys = credentialsData.installed ?? credentialsData.web;
    if (!keys) throw new Error('Invalid credentials.json format');
    const redirectUri = `http://localhost:${customPort}/oauth2callback`;
    return new google.auth.OAuth2(keys.client_id, keys.client_secret, redirectUri);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    try {
      if (pathname === '/api/auth' && req.method === 'POST') {
        const body = await parseRequestBody(req);
        const configured = process.env['WEB_PASSWORD'];
        if (!configured || body['password'] === configured) {
          sendJson(res, 200, { ok: true });
        } else {
          sendJson(res, 401, { ok: false, error: 'Invalid password' });
        }
        return;
      }

      if (pathname === '/api/logs/stream') {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.flushHeaders?.();

        for (const line of logBuffer) {
          res.write(`data: ${JSON.stringify({ log: line, timestamp: new Date().toISOString() })}\n\n`);
        }

        const cleanup = () => {
          sseClients.delete(res);
        };

        sseClients.add(res);
        req.on('close', cleanup);
        req.on('error', cleanup);
        res.on('close', cleanup);
        res.on('error', cleanup);
        return;
      }

      if (pathname === '/api/status' && req.method === 'GET') {
        serverState.isSetup = existsSync(config.gmail.credentialsPath) && existsSync(config.gmail.tokenPath);
        sendJson(res, 200, {
          ...serverState,
          uptimeSeconds: Math.round(process.uptime()),
          requiresPassword: Boolean(process.env['WEB_PASSWORD']),
        });
        return;
      }

      if (pathname === '/api/smart-replies' && req.method === 'GET') {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        const pendingPath = resolveDataPath('pending_replies.json', process.env['PENDING_REPLIES_PATH']);
        let replies: PendingSmartReply[] = [];
        if (existsSync(pendingPath)) {
          try {
            const all = JSON.parse(readFileSync(pendingPath, 'utf-8')) as PendingSmartReply[];
            replies = all.filter((r) => r.status === 'pending');
          } catch {}
        }
        sendJson(res, 200, { replies });
        return;
      }

      if (pathname === '/api/style-profile' && req.method === 'GET') {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        const stylePath = resolveDataPath('learned_response.json', process.env['LEARNED_RESPONSE_PATH']);
        let profile = null;
        if (existsSync(stylePath)) {
          try {
            profile = JSON.parse(readFileSync(stylePath, 'utf-8'));
          } catch {}
        }
        sendJson(res, 200, { profile });
        return;
      }

      if (pathname === '/api/learn-style' && req.method === 'POST') {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        if (!options.onLearnStyle) {
          sendJson(res, 500, { error: 'Style learning callback not configured' });
          return;
        }
        const profile = await options.onLearnStyle();
        sendJson(res, 200, { ok: true, profile });
        return;
      }

      if (pathname === '/api/save-draft' && req.method === 'POST') {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        const body = await parseRequestBody(req);
        const replyId = String(body['id'] ?? '');
        const draftBody = String(body['body'] ?? '');

        if (!replyId || !draftBody) {
          sendJson(res, 400, { error: 'Missing reply ID or draft body' });
          return;
        }

        if (options.onSaveDraft) {
          await options.onSaveDraft({ id: replyId, body: draftBody });
        }

        const pendingPath = resolveDataPath('pending_replies.json', process.env['PENDING_REPLIES_PATH']);
        if (existsSync(pendingPath)) {
          try {
            const all = JSON.parse(readFileSync(pendingPath, 'utf-8')) as PendingSmartReply[];
            const item = all.find((r) => r.id === replyId);
            if (item) {
              item.status = 'drafted';
              writeFileSync(pendingPath, JSON.stringify(all, null, 2), 'utf-8');
            }
          } catch {}
        }

        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/dismiss-reply' && req.method === 'POST') {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        const body = await parseRequestBody(req);
        const replyId = String(body['id'] ?? '');
        const pendingPath = resolveDataPath('pending_replies.json', process.env['PENDING_REPLIES_PATH']);
        if (existsSync(pendingPath)) {
          try {
            const all = JSON.parse(readFileSync(pendingPath, 'utf-8')) as PendingSmartReply[];
            const item = all.find((r) => r.id === replyId);
            if (item) {
              item.status = 'dismissed';
              writeFileSync(pendingPath, JSON.stringify(all, null, 2), 'utf-8');
            }
          } catch {}
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/rules' && req.method === 'GET') {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        const rulesPath = config.classification.learnedRulesPath;
        let rules: LearnedRule[] = [];
        if (existsSync(rulesPath)) {
          try {
            rules = JSON.parse(readFileSync(rulesPath, 'utf-8')) as LearnedRule[];
          } catch {}
        }
        sendJson(res, 200, { rules });
        return;
      }

      if (pathname === '/api/unmatched' && req.method === 'GET') {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        const unmatchedPath = config.classification.unmatchedPath;
        let unmatched: UnmatchedEmailRecord[] = [];
        if (existsSync(unmatchedPath)) {
          try {
            unmatched = JSON.parse(readFileSync(unmatchedPath, 'utf-8')) as UnmatchedEmailRecord[];
          } catch {}
        }
        sendJson(res, 200, { unmatched });
        return;
      }

      if (pathname === '/api/trigger-run' && req.method === 'POST') {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        if (options.onTriggerRun) {
          options.onTriggerRun().catch((err) => {
            appendWebLog(`[ERROR] Manual classification run failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        sendJson(res, 200, { ok: true, message: 'Classification run triggered' });
        return;
      }

      if (pathname === '/api/cull-memory' && req.method === 'POST') {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        if (options.onCullMemory) {
          await options.onCullMemory();
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // First-boot onboarding setup endpoints
      if (pathname === '/api/credentials' && req.method === 'POST') {
        const body = await parseRequestBody(req);
        oAuth2ClientInstance = getOAuthClient(body as unknown as GoogleCredentialsFile, port);
        writeFileSync(config.gmail.credentialsPath, JSON.stringify(body, null, 2), 'utf-8');
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/auth-url' && req.method === 'GET') {
        if (!oAuth2ClientInstance && existsSync(config.gmail.credentialsPath)) {
          const creds = JSON.parse(readFileSync(config.gmail.credentialsPath, 'utf-8')) as GoogleCredentialsFile;
          oAuth2ClientInstance = getOAuthClient(creds, port);
        }
        if (!oAuth2ClientInstance) {
          sendJson(res, 400, { error: 'Credentials not loaded' });
          return;
        }
        const authUrl = oAuth2ClientInstance.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: SCOPES,
        });
        sendJson(res, 200, { url: authUrl });
        return;
      }

      if (pathname === '/oauth2callback' && req.method === 'GET') {
        const code = url.searchParams.get('code');
        if (!code || !oAuth2ClientInstance) {
          sendHtml(res, 400, '<h1>Authentication failed: missing code or client</h1>');
          return;
        }
        const { tokens } = await oAuth2ClientInstance.getToken(code);
        writeFileSync(config.gmail.tokenPath, JSON.stringify(tokens, null, 2), 'utf-8');
        serverState.isSetup = true;
        sendHtml(res, 200, '<script>window.location.href="/"</script>');
        return;
      }

      if (pathname === '/api/manual-auth' && req.method === 'POST') {
        const body = await parseRequestBody(req);
        const codeOrUrl = String(body['codeOrUrl'] ?? '').trim();
        let code = codeOrUrl;
        if (codeOrUrl.includes('code=')) {
          const parsed = new URL(codeOrUrl.startsWith('http') ? codeOrUrl : `http://localhost/${codeOrUrl}`);
          code = parsed.searchParams.get('code') ?? codeOrUrl;
        }
        if (!oAuth2ClientInstance && existsSync(config.gmail.credentialsPath)) {
          const creds = JSON.parse(readFileSync(config.gmail.credentialsPath, 'utf-8')) as GoogleCredentialsFile;
          oAuth2ClientInstance = getOAuthClient(creds, port);
        }
        if (!oAuth2ClientInstance) {
          sendJson(res, 400, { error: 'Credentials not initialized' });
          return;
        }
        const { tokens } = await oAuth2ClientInstance.getToken(code);
        writeFileSync(config.gmail.tokenPath, JSON.stringify(tokens, null, 2), 'utf-8');
        serverState.isSetup = true;
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/' && req.method === 'GET') {
        const hasCredentials = existsSync(config.gmail.credentialsPath);
        const hasToken = existsSync(config.gmail.tokenPath);
        const hasPasswordAuth = Boolean(process.env['WEB_PASSWORD']);

        if (hasCredentials && hasToken) {
          sendHtml(res, 200, renderAppHtml(serverState, hasPasswordAuth));
        } else {
          sendHtml(res, 200, renderAppHtml(serverState, false));
        }
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal server error' });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    appendWebLog(`[INFO] Web dashboard running at http://0.0.0.0:${port}`);
  });

  return server;
};
