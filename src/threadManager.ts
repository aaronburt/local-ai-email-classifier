import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Ollama } from 'ollama';
import { parseThread, type GmailClient } from './gmail.js';
import type {
  ActiveConversationThread,
  ConversationMessageNode,
  ConversationThreadStatus,
  ParsedEmailThread,
  ThreadResolutionAnalysis,
} from './types.js';

export const ThreadResolutionAnalysisSchema = z.object({
  status: z.enum(['waiting_on_me', 'waiting_on_other', 'resolved']).describe('Resolution state of the conversation'),
  other_party_name: z.string().describe('The name or organization of the external party'),
  other_party_email: z.string().describe('The email address of the external party'),
  thread_summary: z.string().describe('Concise 1-sentence executive summary of what is happening in this thread'),
  next_action_needed: z.string().nullable().describe('Action needed next, or null if resolved/closed'),
  confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1'),
});

const parseJsonResponse = <T>(raw: string): T => {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  return JSON.parse(cleaned.trim()) as T;
};

export class ThreadManager {
  private filePath: string;
  private threads: ActiveConversationThread[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.loadThreads();
  }

  private loadThreads(): void {
    if (!existsSync(this.filePath)) {
      this.threads = [];
      return;
    }
    try {
      const data = readFileSync(this.filePath, 'utf-8');
      this.threads = JSON.parse(data) as ActiveConversationThread[];
    } catch {
      this.threads = [];
    }
  }

  public getThreads(filterStatus?: ConversationThreadStatus): ActiveConversationThread[] {
    if (filterStatus) {
      return this.threads.filter((t) => t.status === filterStatus);
    }
    return this.threads;
  }

  public getThread(threadId: string): ActiveConversationThread | undefined {
    return this.threads.find((t) => t.threadId === threadId);
  }

  public updateThreadStatus(threadId: string, status: ConversationThreadStatus): boolean {
    const thread = this.threads.find((t) => t.threadId === threadId);
    if (!thread) return false;
    thread.status = status;
    thread.updatedAt = new Date().toISOString();
    this.saveThreads();
    return true;
  }

  public upsertThread(thread: ActiveConversationThread): void {
    const index = this.threads.findIndex((t) => t.threadId === thread.threadId);
    if (index >= 0) {
      this.threads[index] = { ...this.threads[index], ...thread, updatedAt: new Date().toISOString() };
    } else {
      this.threads.unshift(thread);
    }

    if (this.threads.length > 250) {
      this.threads = this.threads.slice(0, 250);
    }

    this.saveThreads();
  }

  private saveThreads(): void {
    writeFileSync(this.filePath, JSON.stringify(this.threads, null, 2), 'utf-8');
  }
}

export const buildMessageNodes = (
  parsedThread: ParsedEmailThread,
  userEmail: string
): ConversationMessageNode[] => {
  const normalizedUserEmail = userEmail.toLowerCase().trim();

  return parsedThread.messages.map((m) => {
    const senderLower = m.sender.toLowerCase();
    const isFromUser = normalizedUserEmail.length > 0 && senderLower.includes(normalizedUserEmail);

    return {
      messageId: m.id,
      sender: m.sender,
      recipient: m.recipient,
      date: m.date,
      snippet: m.cleanBody.slice(0, 160).replace(/\s+/g, ' ').trim(),
      bodyText: m.cleanBody,
      isFromUser,
    };
  });
};

export const analyzeThreadResolution = async (
  parsedThread: ParsedEmailThread,
  userEmail: string,
  ollamaHost: string,
  modelName: string
): Promise<ThreadResolutionAnalysis> => {
  const client = new Ollama({ host: ollamaHost });
  const jsonSchema = zodToJsonSchema(ThreadResolutionAnalysisSchema, 'ThreadResolution');

  const messageCount = parsedThread.messages.length;
  const latestMessage = parsedThread.messages[messageCount - 1];
  const firstMessage = parsedThread.messages[0];

  const normalizedUserEmail = userEmail.toLowerCase().trim();
  const latestSenderLower = (latestMessage?.sender ?? '').toLowerCase();
  const isLatestFromUser = normalizedUserEmail.length > 0 && latestSenderLower.includes(normalizedUserEmail);

  const systemPrompt = `You are an expert conversation resolution analyzer.
Your mission is to inspect the full chronological history of an email thread involving the user (${userEmail || 'the user'}) and determine its resolution state.

STATUS CRITERIA:
1. "waiting_on_me": The latest message is from the external party requesting info, asking a question, scheduling an appointment, or expecting a response/action from the user.
2. "waiting_on_other": The user sent the latest reply or enquiry, and is now waiting for the external party to respond, deliver goods, or confirm.
3. "resolved": The issue is concluded, settled, thank-you acknowledged with no pending questions, or closed.

RULES:
- Identify the external party's clean name and email address.
- Provide a concise 1-sentence executive summary of the entire thread.
- If unresolved, state the specific next action needed.
- Output valid structured JSON.`;

  const userPrompt = `EMAIL THREAD:
Subject: ${parsedThread.subject}
Messages in Thread: ${messageCount}
First Sender: ${firstMessage?.sender ?? 'Unknown'}
Latest Sender: ${latestMessage?.sender ?? 'Unknown'} (Is from user: ${isLatestFromUser})

FULL THREAD TIMELINE:
${parsedThread.fullConversationContext.slice(-6000)}

Analyze this thread and output structured JSON.`;

  const response = await client.chat({
    model: modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    format: jsonSchema as Record<string, unknown>,
    options: {
      temperature: 0.1,
    },
  });

  const raw = parseJsonResponse<Record<string, unknown>>(response.message.content);

  const rawStatus = String(raw['status'] ?? '');
  let status: ConversationThreadStatus = 'waiting_on_other';
  if (rawStatus === 'waiting_on_me' || rawStatus === 'waiting_on_other' || rawStatus === 'resolved') {
    status = rawStatus;
  } else if (!isLatestFromUser) {
    status = 'waiting_on_me';
  }

  return {
    status,
    other_party_name: String(raw['other_party_name'] ?? raw['otherPartyName'] ?? latestMessage?.sender ?? 'External Party'),
    other_party_email: String(raw['other_party_email'] ?? raw['otherPartyEmail'] ?? ''),
    thread_summary: String(raw['thread_summary'] ?? raw['threadSummary'] ?? 'Ongoing email conversation.'),
    next_action_needed: raw['next_action_needed'] ? String(raw['next_action_needed']) : null,
    confidence: typeof raw['confidence'] === 'number' ? raw['confidence'] : 0.95,
  };
};

export const scanActiveThreads = async (
  gmailClient: GmailClient,
  threadManager: ThreadManager,
  ollamaHost: string,
  modelName: string,
  maxThreads = 25
): Promise<ActiveConversationThread[]> => {
  const userEmail = await gmailClient.getUserEmail().catch(() => '');
  const candidateThreadIds = await gmailClient.listCandidateThreadIds(maxThreads);

  const processedThreads: ActiveConversationThread[] = [];

  for (const threadId of candidateThreadIds) {
    try {
      const rawThread = await gmailClient.getThread(threadId);
      const parsedThread = await parseThread(rawThread, gmailClient);

      // Only multi-message conversations involving distinct parties or user participation
      const distinctSenders = new Set(parsedThread.messages.map((m) => m.sender.toLowerCase().trim()));
      const hasUserMessage = parsedThread.messages.some((m) =>
        userEmail ? m.sender.toLowerCase().includes(userEmail.toLowerCase()) : false
      );

      if (parsedThread.messages.length < 2 || (distinctSenders.size < 2 && !hasUserMessage)) {
        continue;
      }

      const messageNodes = buildMessageNodes(parsedThread, userEmail);
      const analysis = await analyzeThreadResolution(parsedThread, userEmail, ollamaHost, modelName);

      const latestMessage = parsedThread.messages[parsedThread.messages.length - 1];

      const activeThread: ActiveConversationThread = {
        threadId,
        subject: parsedThread.subject || 'No Subject',
        otherParty: analysis.other_party_name,
        otherPartyEmail: analysis.other_party_email,
        status: analysis.status,
        lastMessageDate: latestMessage?.date ?? new Date().toISOString(),
        messageCount: parsedThread.messages.length,
        threadSummary: analysis.thread_summary,
        nextActionNeeded: analysis.next_action_needed ?? undefined,
        messages: messageNodes,
        updatedAt: new Date().toISOString(),
      };

      threadManager.upsertThread(activeThread);
      processedThreads.push(activeThread);
    } catch {
      // Skip failed thread evaluation
    }
  }

  return processedThreads;
};
