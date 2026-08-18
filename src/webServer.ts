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

export const appendWebLog = (rawLine: string): void => {
  const line = rawLine.trim();
  if (!line) return;
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer.shift();
  }

  const sseData = `data: ${JSON.stringify({ log: line, timestamp: new Date().toISOString() })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(sseData);
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
      --bg: #090d16;
      --card: #111827;
      --card-alt: #1a2234;
      --border: #1f293d;
      --border-focus: #3b82f6;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --error: #ef4444;
      --warning: #f59e0b;
      --code-bg: #0d1117;
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
    }
    header {
      background-color: var(--card);
      border-bottom: 1px solid var(--border);
      padding: 16px 24px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand svg {
      width: 28px;
      height: 28px;
      fill: var(--primary);
    }
    .brand h1 {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .btn {
      background-color: var(--primary);
      color: #ffffff;
      border: none;
      border-radius: 6px;
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background 0.15s;
    }
    .btn:hover:not(:disabled) {
      background-color: var(--primary-hover);
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-secondary {
      background-color: var(--card-alt);
      border: 1px solid var(--border);
      color: var(--text);
    }
    .btn-secondary:hover:not(:disabled) {
      background-color: #242f48;
    }
    .badge {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 3px 8px;
      border-radius: 9999px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .badge-success { background: rgba(16, 185, 129, 0.15); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-warning { background: rgba(245, 158, 11, 0.15); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-info { background: rgba(59, 130, 246, 0.15); color: var(--primary); border: 1px solid rgba(59, 130, 246, 0.3); }
    
    .status-bar {
      background-color: #0d1322;
      border-bottom: 1px solid var(--border);
      padding: 10px 24px;
      display: flex;
      flex-wrap: wrap;
      gap: 24px;
      font-size: 13px;
      color: var(--text-muted);
    }
    .status-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-item strong {
      color: var(--text);
    }
    
    .nav-tabs {
      display: flex;
      gap: 4px;
      padding: 12px 24px 0 24px;
      border-bottom: 1px solid var(--border);
      background-color: var(--card);
    }
    .tab {
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.15s;
    }
    .tab:hover {
      color: var(--text);
    }
    .tab.active {
      color: var(--primary);
      border-bottom-color: var(--primary);
    }
    
    main {
      flex: 1;
      padding: 24px;
      max-width: 1400px;
      width: 100%;
      margin: 0 auto;
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    
    .terminal-window {
      background-color: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      height: calc(100vh - 240px);
      min-height: 480px;
    }
    .terminal-header {
      background-color: var(--card);
      border-bottom: 1px solid var(--border);
      padding: 8px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-muted);
    }
    .terminal-body {
      flex: 1;
      padding: 16px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12.5px;
      line-height: 1.6;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .log-line {
      margin-bottom: 2px;
    }
    .log-info { color: #93c5fd; }
    .log-success { color: #34d399; font-weight: 600; }
    .log-warn { color: #fbbf24; }
    .log-error { color: #f87171; font-weight: 600; }
    
    .table-container {
      background-color: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
    }
    th {
      background-color: #141c2e;
      padding: 12px 16px;
      font-weight: 600;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      color: var(--text);
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background-color: rgba(255, 255, 255, 0.02); }
    
    .reply-card {
      background-color: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .reply-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 12px;
    }
    .snippet-box {
      background-color: var(--card-alt);
      border-left: 3px solid var(--primary);
      padding: 10px 14px;
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 14px;
      border-radius: 0 4px 4px 0;
    }
    .draft-textarea {
      width: 100%;
      min-height: 120px;
      background-color: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      color: var(--text);
      font-family: inherit;
      font-size: 13.5px;
      line-height: 1.5;
      resize: vertical;
      outline: none;
      margin-bottom: 14px;
    }
    .draft-textarea:focus {
      border-color: var(--primary);
    }

    #auth-overlay {
      position: fixed;
      inset: 0;
      background: rgba(9, 13, 22, 0.9);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .auth-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 32px;
      width: 100%;
      max-width: 380px;
      text-align: center;
    }
    input[type="password"] {
      width: 100%;
      background: var(--card-alt);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 14px;
      color: var(--text);
      font-size: 14px;
      margin: 16px 0;
      outline: none;
    }
    input[type="password"]:focus {
      border-color: var(--primary);
    }
  </style>
</head>
<body>
  ${hasPasswordAuth ? `
  <div id="auth-overlay">
    <div class="auth-card">
      <h2 style="font-size: 18px; margin-bottom: 8px;">Access Restricted</h2>
      <p style="font-size: 13px; color: var(--text-muted);">Enter your WEB_PASSWORD to continue:</p>
      <input type="password" id="auth-pwd-input" placeholder="Password" onkeydown="if(event.key==='Enter') submitAuth()">
      <button class="btn" style="width: 100%; justify-content: center;" onclick="submitAuth()">Unlock Dashboard</button>
      <p id="auth-error" style="color: var(--error); font-size: 12px; margin-top: 10px; display: none;">Invalid password</p>
    </div>
  </div>` : ''}

  <header>
    <div class="brand">
      <svg viewBox="0 0 24 24">
        <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
      </svg>
      <div>
        <h1>Local AI Email Classifier</h1>
      </div>
      <span id="daemon-badge" class="badge badge-success">Daemon Healthy</span>
    </div>

    <div class="header-actions">
      <button id="btn-run" class="btn" onclick="triggerRun()">
        <svg style="width: 14px; height: 14px; fill: currentColor;" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        Classify Now
      </button>
      <button id="btn-cull" class="btn btn-secondary" onclick="cullMemory()">
        <svg style="width: 14px; height: 14px; fill: currentColor;" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        Cull Memory
      </button>
    </div>
  </header>

  <div class="status-bar">
    <div class="status-item">Local Model: <strong id="stat-model">${state.model}</strong></div>
    ${state.remoteModel ? `<div class="status-item">Remote Escalation: <strong id="stat-remote">${state.remoteModel}</strong></div>` : ''}
    <div class="status-item">Schedule: <strong id="stat-cron">${state.cronSchedule}</strong></div>
    <div class="status-item">Status: <strong id="stat-status">Idle</strong></div>
  </div>

  <div class="nav-tabs">
    <div class="tab active" onclick="switchTab('logs')">Live Logs</div>
    <div class="tab" onclick="switchTab('replies')">💬 Smart Replies (<span id="reply-count">-</span>)</div>
    <div class="tab" onclick="switchTab('rules')">Learned Rules (<span id="rule-count">-</span>)</div>
    <div class="tab" onclick="switchTab('unmatched')">Unmatched Queue (<span id="unmatched-count">-</span>)</div>
  </div>

  <main>
    <!-- Tab 1: Live Logs -->
    <div id="tab-logs" class="tab-content active">
      <div class="terminal-window">
        <div class="terminal-header">
          <span>Real-time SSE Stream</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <label style="font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
              <input type="checkbox" id="auto-scroll-chk" checked> Auto-Scroll
            </label>
            <button class="btn btn-secondary" style="padding: 3px 8px; font-size: 11px;" onclick="clearLogs()">Clear</button>
          </div>
        </div>
        <div id="terminal-body" class="terminal-body"></div>
      </div>
    </div>

    <!-- Tab 2: Smart Replies -->
    <div id="tab-replies" class="tab-content">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; background: var(--card); padding: 14px 20px; border-radius: 8px; border: 1px solid var(--border);">
        <div>
          <h3 style="font-size: 14px; font-weight: 600;">Personal Reply Style Profile</h3>
          <p id="style-summary" style="font-size: 12.5px; color: var(--text-muted); margin-top: 2px;">Loading style profile...</p>
        </div>
        <button id="btn-learn-style" class="btn btn-secondary" onclick="learnStyle()">
          ⚡ Learn / Refresh My Style
        </button>
      </div>

      <div id="replies-list">
        <div style="text-align: center; padding: 48px; color: var(--text-muted);">Loading smart reply suggestions...</div>
      </div>
    </div>

    <!-- Tab 3: Learned Rules -->
    <div id="tab-rules" class="tab-content">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th style="width: 22%;">Sender Domain</th>
              <th style="width: 18%;">Target Label</th>
              <th style="width: 25%;">Condition</th>
              <th style="width: 35%;">Reasoning</th>
            </tr>
          </thead>
          <tbody id="rules-tbody">
            <tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Loading rules...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab 4: Unmatched Queue -->
    <div id="tab-unmatched" class="tab-content">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th style="width: 25%;">Subject</th>
              <th style="width: 20%;">Sender</th>
              <th style="width: 10%;">Confidence</th>
              <th style="width: 45%;">Reasoning</th>
            </tr>
          </thead>
          <tbody id="unmatched-tbody">
            <tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Loading unmatched items...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <script>
    let autoscroll = true;
    const terminalEl = document.getElementById('terminal-body');
    const autoScrollChk = document.getElementById('auto-scroll-chk');

    autoScrollChk.addEventListener('change', (e) => {
      autoscroll = e.target.checked;
    });

    const formatLogLine = (text) => {
      let colorClass = 'log-line';
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
      terminalEl.innerHTML += formatLogLine(text);
      if (autoscroll) {
        terminalEl.scrollTop = terminalEl.scrollHeight;
      }
    };

    const clearLogs = () => {
      terminalEl.innerHTML = '';
    };

    const switchTab = (tabName) => {
      document.querySelectorAll('.tab').forEach((t, i) => {
        const isSelected = (tabName === 'logs' && i === 0) || (tabName === 'replies' && i === 1) || (tabName === 'rules' && i === 2) || (tabName === 'unmatched' && i === 3);
        t.className = isSelected ? 'tab active' : 'tab';
      });
      document.querySelectorAll('.tab-content').forEach((tc) => tc.classList.remove('active'));
      document.getElementById('tab-' + tabName).classList.add('active');

      if (tabName === 'replies') { loadReplies(); loadStyleProfile(); }
      if (tabName === 'rules') loadRules();
      if (tabName === 'unmatched') loadUnmatched();
    };

    // Live Server-Sent Events (SSE) log stream
    const initLogStream = () => {
      const source = new EventSource('/api/logs/stream');
      source.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.log) {
            appendLogToView(data.log);
          }
        } catch {}
      };
      source.onerror = () => {
        setTimeout(initLogStream, 3000);
      };
    };

    const triggerRun = async () => {
      const btn = document.getElementById('btn-run');
      btn.disabled = true;
      btn.innerHTML = 'Running...';
      document.getElementById('stat-status').textContent = 'Classifying';
      document.getElementById('daemon-badge').className = 'badge badge-warning';
      document.getElementById('daemon-badge').textContent = 'Classifying';

      try {
        const res = await fetch('/api/trigger-run', { method: 'POST' });
        const data = await res.json();
        if (!data.ok) alert(data.error || 'Failed to trigger run');
      } catch (err) {
        alert('Network error triggering run');
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = '<svg style="width: 14px; height: 14px; fill: currentColor;" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Classify Now';
          document.getElementById('stat-status').textContent = 'Idle';
          document.getElementById('daemon-badge').className = 'badge badge-success';
          document.getElementById('daemon-badge').textContent = 'Daemon Healthy';
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
        const tbody = document.getElementById('rules-tbody');
        document.getElementById('rule-count').textContent = data.rules?.length || 0;
        if (!data.rules || data.rules.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No learned rules found</td></tr>';
          return;
        }
        tbody.innerHTML = data.rules.map(r => '<tr>' +
          '<td><code>' + (r.senderDomain || '-') + '</code></td>' +
          '<td><span class="badge badge-info">' + (r.targetLabel || '-') + '</span></td>' +
          '<td style="color: var(--text-muted);">' + (r.topicCondition || '-') + '</td>' +
          '<td style="color: var(--text-muted);">' + (r.reasoning || '-') + '</td>' +
          '</tr>').join('');
      } catch {}
    };

    const loadUnmatched = async () => {
      try {
        const res = await fetch('/api/unmatched');
        const data = await res.json();
        const tbody = document.getElementById('unmatched-tbody');
        document.getElementById('unmatched-count').textContent = data.unmatched?.length || 0;
        if (!data.unmatched || data.unmatched.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Queue is empty</td></tr>';
          return;
        }
        tbody.innerHTML = data.unmatched.map(u => '<tr>' +
          '<td><strong>' + (u.subject || 'No Subject') + '</strong></td>' +
          '<td>' + (u.sender || 'Unknown') + '</td>' +
          '<td><span class="badge badge-warning">' + (u.confidence || '0.00') + '</span></td>' +
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
          document.getElementById('style-summary').innerHTML = 'Tone: <strong>' + (p.tone || 'Natural') + '</strong> | Sign-off: <code>' + (p.defaultSignoffs?.[0]?.replace(/\\n/g, ' ') || 'Thanks') + '</code> | ~' + (p.averageLengthWords || 40) + ' words';
        }
      } catch {}
    };

    const learnStyle = async () => {
      const btn = document.getElementById('btn-learn-style');
      btn.disabled = true;
      btn.textContent = 'Analyzing Sent Mail...';
      try {
        const res = await fetch('/api/learn-style', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          loadStyleProfile();
          alert('Personal style profile successfully analyzed and updated!');
        } else {
          alert(data.error || 'Failed to learn style');
        }
      } catch (err) {
        alert('Error learning style profile');
      } finally {
        btn.disabled = false;
        btn.textContent = '⚡ Learn / Refresh My Style';
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
          listEl.innerHTML = '<div style="text-align: center; padding: 48px; color: var(--text-muted); background: var(--card); border: 1px solid var(--border); border-radius: 8px;">No pending smart replies. All actionable emails have been addressed! 🎉</div>';
          return;
        }

        listEl.innerHTML = replies.map(r => '<div class="reply-card" id="reply-card-' + r.id + '">' +
          '<div class="reply-header">' +
            '<div>' +
              '<h4 style="font-size: 15px; font-weight: 600; color: var(--text);">' + (r.subject || 'No Subject') + '</h4>' +
              '<div style="font-size: 12.5px; color: var(--text-muted); margin-top: 2px;">From: <strong>' + (r.sender || 'Unknown') + '</strong> &bull; ' + (r.receivedAt || '') + '</div>' +
            '</div>' +
            '<span class="badge badge-info">' + Math.round((r.confidence || 0) * 100) + '% match</span>' +
          '</div>' +
          '<div class="snippet-box">' + (r.originalSnippet || '') + '</div>' +
          '<label style="font-size: 12px; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 6px;">Suggested Draft (Editable):</label>' +
          '<textarea id="draft-text-' + r.id + '" class="draft-textarea">' + (r.suggestedReply || '') + '</textarea>' +
          '<div style="display: flex; justify-content: space-between; align-items: center;">' +
            '<div style="display: flex; gap: 8px;">' +
              '<button class="btn" id="btn-save-' + r.id + '" onclick="saveDraft(\\'' + r.id + '\\')">📝 Save as Gmail Draft</button>' +
              '<button class="btn btn-secondary" onclick="dismissReply(\\'' + r.id + '\\')">✕ Dismiss</button>' +
            '</div>' +
            '<span style="font-size: 12px; color: var(--text-muted);">' + (r.reasoning || '') + '</span>' +
          '</div>' +
        '</div>').join('');
      } catch {}
    };

    const saveDraft = async (id) => {
      const btn = document.getElementById('btn-save-' + id);
      const text = document.getElementById('draft-text-' + id).value;
      btn.disabled = true;
      btn.textContent = 'Saving to Gmail...';

      try {
        const res = await fetch('/api/save-draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, body: text })
        });
        const data = await res.json();
        if (data.ok) {
          btn.className = 'btn btn-secondary';
          btn.innerHTML = '✓ Draft Saved in Gmail!';
          setTimeout(() => {
            document.getElementById('reply-card-' + id)?.remove();
            loadReplies();
          }, 1200);
        } else {
          alert(data.error || 'Failed to save draft in Gmail');
          btn.disabled = false;
          btn.textContent = '📝 Save as Gmail Draft';
        }
      } catch (err) {
        alert('Network error saving draft');
        btn.disabled = false;
        btn.textContent = '📝 Save as Gmail Draft';
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
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        for (const line of logBuffer) {
          res.write(`data: ${JSON.stringify({ log: line, timestamp: new Date().toISOString() })}\n\n`);
        }

        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
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
