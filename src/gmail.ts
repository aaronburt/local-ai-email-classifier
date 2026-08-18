import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { google, gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { convert } from 'html-to-text';
import pdfParse from 'pdf-parse';
import type { EmailAttachment, GmailUserLabel, ParsedEmailMessage, ParsedEmailThread } from './types.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

const QUOTED_REPLY_PATTERNS = [
  /^>+.*$/gm,
  /^On\s+.+?wrote:.*$/ims,
  /^From:\s+.+?Sent:\s+.+?To:\s+.+?Subject:.*$/ims,
  /^-+Original Message-+.*$/ims,
  /^_{5,}.*$/ims,
];

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

export const getAuthenticatedClient = async (
  credentialsPath: string,
  tokenPath: string,
  oauthPort = 3000
): Promise<OAuth2Client> => {
  if (!existsSync(credentialsPath)) {
    throw new Error(
      `Gmail credentials not found at ${credentialsPath}. Please download OAuth 2.0 Client credentials from Google Cloud Console.`
    );
  }

  const fileContent = readFileSync(credentialsPath, 'utf-8');
  const credentials = JSON.parse(fileContent) as GoogleCredentialsFile;
  const config = credentials.installed ?? credentials.web;

  if (!config) {
    throw new Error('Invalid credentials.json file format: missing "installed" or "web" key.');
  }

  const { client_id, client_secret } = config;
  const redirectUri = `http://localhost:${oauthPort}/oauth2callback`;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  if (existsSync(tokenPath)) {
    const tokenContent = readFileSync(tokenPath, 'utf-8');
    const token = JSON.parse(tokenContent);
    oauth2Client.setCredentials(token);
    return oauth2Client;
  }

  return authenticateWithLocalServer(oauth2Client, tokenPath, oauthPort);
};

const authenticateWithLocalServer = async (
  oauth2Client: OAuth2Client,
  tokenPath: string,
  oauthPort: number
): Promise<OAuth2Client> => {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (!req.url || !req.url.startsWith('/oauth2callback')) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const url = new URL(req.url, `http://127.0.0.1:${oauthPort}`);
        const code = url.searchParams.get('code');

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing authorization code in callback');
          reject(new Error('Missing authorization code'));
          server.close();
          return;
        }

        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), 'utf-8');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authentication successful!</h1><p>You can close this browser tab and return to the terminal.</p>');

        server.close();
        resolve(oauth2Client);
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Authentication failed');
        server.close();
        reject(error);
      }
    });

    server.listen(oauthPort, 'localhost', () => {
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
      });
      process.stdout.write(`Please authenticate by opening this URL in your browser:\n\n${authUrl}\n\n`);
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
};

const withBackoff = async <T>(
  operation: () => Promise<T>,
  maxRetries = 5,
  baseDelayMs = 1000,
  maxDelayMs = 15000
): Promise<T> => {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err: unknown) {
      attempt += 1;
      const errorObj = err as { status?: number; code?: number; message?: string };
      const status = errorObj?.status ?? errorObj?.code;
      const msg = errorObj?.message ?? '';
      const isTransient =
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('EAI_AGAIN') ||
        msg.includes('Rate Limit Exceeded') ||
        msg.includes('User Rate Limit Exceeded');

      if (attempt > maxRetries || !isTransient) {
        throw err;
      }

      const calculatedDelay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const jitter = Math.random() * 500;
      const delay = Math.min(calculatedDelay + jitter, maxDelayMs);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

export class GmailClient {
  private gmail: gmail_v1.Gmail;

  constructor(auth: OAuth2Client) {
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  async getUserLabels(): Promise<GmailUserLabel[]> {
    return withBackoff(async () => {
      const response = await this.gmail.users.labels.list({ userId: 'me' });
      const labels = response.data.labels ?? [];

      return labels
        .filter((label): label is gmail_v1.Schema$Label & { id: string; name: string } => {
          return Boolean(label.id && label.name && label.type === 'user');
        })
        .map((label) => ({
          id: label.id,
          name: label.name,
          type: label.type ?? 'user',
        }));
    });
  }

  async getOrCreateLabel(name: string): Promise<GmailUserLabel> {
    const userLabels = await this.getUserLabels();
    const existing = userLabels.find((label) => label.name.toLowerCase() === name.toLowerCase());

    if (existing) {
      return existing;
    }

    return withBackoff(async () => {
      const created = await this.gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
        },
      });

      if (!created.data.id || !created.data.name) {
        throw new Error(`Failed to create label "${name}" in Gmail.`);
      }

      return {
        id: created.data.id,
        name: created.data.name,
        type: 'user',
      };
    });
  }

  async listUnlabeledMessageIds(query: string, maxResults = 10): Promise<string[]> {
    return withBackoff(async () => {
      const response = await this.gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults,
      });

      const messages = response.data.messages ?? [];
      return messages.map((message) => message.id).filter((id): id is string => typeof id === 'string');
    });
  }

  async getMessage(messageId: string): Promise<gmail_v1.Schema$Message> {
    return withBackoff(async () => {
      const response = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });

      return response.data;
    });
  }

  async getThread(threadId: string): Promise<gmail_v1.Schema$Thread> {
    return withBackoff(async () => {
      const response = await this.gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'full',
      });

      return response.data;
    });
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    return withBackoff(async () => {
      const response = await this.gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId,
      });

      const base64Data = response.data.data ?? '';
      return Buffer.from(base64Data, 'base64url');
    });
  }

  async listSentMessages(maxResults = 50): Promise<gmail_v1.Schema$Message[]> {
    const messageIds = await this.listUnlabeledMessageIds('in:sent -in:drafts', maxResults);
    const messages: gmail_v1.Schema$Message[] = [];
    for (const id of messageIds) {
      try {
        const msg = await this.getMessage(id);
        messages.push(msg);
      } catch {}
    }
    return messages;
  }

  async createDraftReply(options: {
    threadId: string;
    to: string;
    subject: string;
    body: string;
    inReplyToMessageId?: string;
  }): Promise<gmail_v1.Schema$Draft> {
    return withBackoff(async () => {
      const cleanSubject = options.subject.startsWith('Re:') ? options.subject : `Re: ${options.subject}`;
      const headers = [
        `To: ${options.to}`,
        `Subject: ${cleanSubject}`,
        'Content-Type: text/plain; charset=utf-8',
        'MIME-Version: 1.0',
      ];

      if (options.inReplyToMessageId) {
        headers.push(`In-Reply-To: ${options.inReplyToMessageId}`);
        headers.push(`References: ${options.inReplyToMessageId}`);
      }

      const rawEmail = `${headers.join('\r\n')}\r\n\r\n${options.body}`;
      const encodedMessage = Buffer.from(rawEmail, 'utf-8').toString('base64url');

      const response = await this.gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            threadId: options.threadId,
            raw: encodedMessage,
          },
        },
      });

      return response.data;
    });
  }

  async getUserEmail(): Promise<string> {
    return withBackoff(async () => {
      const profile = await this.gmail.users.getProfile({ userId: 'me' });
      return profile.data.emailAddress ?? '';
    });
  }

  async listCandidateThreadIds(maxResults = 30): Promise<string[]> {
    return withBackoff(async () => {
      const response = await this.gmail.users.threads.list({
        userId: 'me',
        q: '(in:inbox OR in:sent) -in:trash -in:spam',
        maxResults,
      });
      const threads = response.data.threads ?? [];
      return threads.map((t) => t.id).filter((id): id is string => typeof id === 'string');
    });
  }

  async listAllMessageIds(query: string): Promise<string[]> {
    const allIds: string[] = [];
    let pageToken: string | undefined;

    do {
      const currentPageToken = pageToken;
      const response = await withBackoff(async () => {
        return this.gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: 500,
          pageToken: currentPageToken,
        });
      });

      const messages = response.data.messages ?? [];
      for (const message of messages) {
        if (message.id) {
          allIds.push(message.id);
        }
      }

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return allIds;
  }

  async applyLabel(messageId: string, labelId?: string, removeLabelIds: string[] = []): Promise<void> {
    await withBackoff(async () => {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          ...(labelId ? { addLabelIds: [labelId] } : {}),
          ...(removeLabelIds.length > 0 ? { removeLabelIds } : {}),
        },
      });
    });
  }

  async archiveMessage(messageId: string): Promise<void> {
    await withBackoff(async () => {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          removeLabelIds: ['INBOX'],
        },
      });
    });
  }

  async batchArchiveMessages(messageIds: string[], alsoMarkRead = false): Promise<void> {
    const removeLabelIds = alsoMarkRead ? ['INBOX', 'UNREAD'] : ['INBOX'];
    await this.batchModifyLabels(messageIds, { removeLabelIds });
  }

  async batchModifyLabels(
    messageIds: string[],
    options: { addLabelIds?: string[]; removeLabelIds?: string[] }
  ): Promise<void> {
    if (messageIds.length === 0) return;
    const CHUNK_SIZE = 1000;
    for (let i = 0; i < messageIds.length; i += CHUNK_SIZE) {
      const chunk = messageIds.slice(i, i + CHUNK_SIZE);
      await withBackoff(async () => {
        await this.gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: chunk,
            ...(options.addLabelIds && options.addLabelIds.length > 0 ? { addLabelIds: options.addLabelIds } : {}),
            ...(options.removeLabelIds && options.removeLabelIds.length > 0 ? { removeLabelIds: options.removeLabelIds } : {}),
          },
        });
      });
    }
  }
}

export const extractPdfText = async (buffer: Buffer): Promise<string> => {
  try {
    const data = await pdfParse(buffer);
    return data.text.trim();
  } catch {
    return '';
  }
};

export const findAttachmentsInPayload = (
  payload?: gmail_v1.Schema$MessagePart
): Array<{ filename: string; mimeType: string; sizeBytes: number; attachmentId?: string }> => {
  if (!payload) {
    return [];
  }

  const attachments: Array<{
    filename: string;
    mimeType: string;
    sizeBytes: number;
    attachmentId?: string;
  }> = [];

  const traverse = (part: gmail_v1.Schema$MessagePart) => {
    if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        sizeBytes: part.body.size ?? 0,
        attachmentId: part.body.attachmentId,
      });
    }

    if (part.parts) {
      for (const nested of part.parts) {
        traverse(nested);
      }
    }
  };

  traverse(payload);
  return attachments;
};

export const cleanEmailHtml = (htmlContent: string): string => {
  const plain = convert(htmlContent, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
    ],
  });

  return stripQuotedReplies(plain);
};

export const stripQuotedReplies = (text: string): string => {
  let cleaned = text;

  for (const pattern of QUOTED_REPLY_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  return cleaned
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

export const extractMessageBody = (payload?: gmail_v1.Schema$MessagePart): string => {
  if (!payload) {
    return '';
  }

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return stripQuotedReplies(Buffer.from(payload.body.data, 'base64url').toString('utf-8'));
  }

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return cleanEmailHtml(Buffer.from(payload.body.data, 'base64url').toString('utf-8'));
  }

  if (payload.parts && payload.parts.length > 0) {
    const plainPart = findPartByMimeType(payload.parts, 'text/plain');
    if (plainPart?.body?.data) {
      return stripQuotedReplies(Buffer.from(plainPart.body.data, 'base64url').toString('utf-8'));
    }

    const htmlPart = findPartByMimeType(payload.parts, 'text/html');
    if (htmlPart?.body?.data) {
      return cleanEmailHtml(Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8'));
    }

    const nestedTexts: string[] = [];
    for (const part of payload.parts) {
      const extracted = extractMessageBody(part);
      if (extracted) {
        nestedTexts.push(extracted);
      }
    }
    if (nestedTexts.length > 0) {
      return nestedTexts.join('\n\n');
    }
  }

  return '';
};

const findPartByMimeType = (
  parts: gmail_v1.Schema$MessagePart[],
  mimeType: string
): gmail_v1.Schema$MessagePart | undefined => {
  for (const part of parts) {
    if (part.mimeType === mimeType) {
      return part;
    }
    if (part.parts) {
      const nested = findPartByMimeType(part.parts, mimeType);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
};

export const parseThread = async (
  thread: gmail_v1.Schema$Thread,
  gmailClient: GmailClient,
  summarizeAttachmentCallback?: (filename: string, mimeType: string, rawText: string) => Promise<string>
): Promise<ParsedEmailThread> => {
  const rawMessages = thread.messages ?? [];
  const parsedMessages: ParsedEmailMessage[] = [];

  for (const message of rawMessages) {
    if (!message.id) continue;
    const parsed = await parseMessage(message, gmailClient, summarizeAttachmentCallback);
    parsedMessages.push(parsed);
  }

  const firstSubject = parsedMessages[0]?.subject ?? 'No Subject';
  const fullConversationContext = parsedMessages.map((msg) => msg.cleanBody).join('\n\n---\n\n');

  return {
    threadId: thread.id ?? 'unknown',
    subject: firstSubject,
    messages: parsedMessages,
    fullConversationContext,
  };
};

export const parseMessage = async (
  message: gmail_v1.Schema$Message,
  gmailClient: GmailClient,
  summarizeAttachmentCallback?: (filename: string, mimeType: string, rawText: string) => Promise<string>
): Promise<ParsedEmailMessage> => {
  const headers = message.payload?.headers ?? [];
  const getHeader = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

  const sender = getHeader('From');
  const recipient = getHeader('To');
  const subject = getHeader('Subject');
  const date = getHeader('Date');
  const cleanBody = extractMessageBody(message.payload);

  const attachmentsMeta = findAttachmentsInPayload(message.payload);
  const attachments: EmailAttachment[] = [];

  for (const attachmentMeta of attachmentsMeta) {
    let extractedText: string | undefined;

    if (attachmentMeta.mimeType === 'application/pdf' && attachmentMeta.attachmentId && message.id) {
      try {
        const pdfBuffer = await gmailClient.getAttachment(message.id, attachmentMeta.attachmentId);
        const rawPdfText = await extractPdfText(pdfBuffer);
        if (rawPdfText && rawPdfText.length > 0 && summarizeAttachmentCallback) {
          extractedText = await summarizeAttachmentCallback(attachmentMeta.filename, attachmentMeta.mimeType, rawPdfText);
        } else if (rawPdfText) {
          extractedText = rawPdfText;
        }
      } catch {
        // Attachment text extraction failed gracefully
      }
    }

    attachments.push({
      filename: attachmentMeta.filename,
      mimeType: attachmentMeta.mimeType,
      sizeBytes: attachmentMeta.sizeBytes,
      extractedText,
    });
  }

  return {
    id: message.id ?? '',
    threadId: message.threadId ?? '',
    sender,
    recipient,
    subject,
    date,
    cleanBody,
    attachments,
    labelIds: message.labelIds ?? [],
  };
};
