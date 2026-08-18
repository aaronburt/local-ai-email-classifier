import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Ollama } from 'ollama';
import { extractMessageBody, type GmailClient } from './gmail.js';
import {
  StyleProfileSchema,
  type LearnedStyleProfile,
  type ParsedEmailThread,
  type PendingSmartReply,
  type SmartReplyGeneration,
} from './types.js';

export const DEFAULT_STYLE_PROFILE: LearnedStyleProfile = {
  tone: 'Direct, helpful, polite, and concise',
  defaultGreetings: ['Hi', 'Hello'],
  defaultSignoffs: ['Thanks,\nAaron', 'Best,\nAaron'],
  averageLengthWords: 40,
  styleGuidelines: [
    'Gets straight to the point without excessive corporate pleasantries',
    'Uses short paragraphs and concise bullet points when appropriate',
    'Maintains a friendly, professional tone',
  ],
  learnedTemplates: [],
  updatedAt: new Date().toISOString(),
};

export class StyleProfileManager {
  private filePath: string;
  private profile: LearnedStyleProfile;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.profile = this.loadProfile();
  }

  private loadProfile(): LearnedStyleProfile {
    if (!existsSync(this.filePath)) {
      return DEFAULT_STYLE_PROFILE;
    }
    try {
      const data = readFileSync(this.filePath, 'utf-8');
      return StyleProfileSchema.parse(JSON.parse(data));
    } catch {
      return DEFAULT_STYLE_PROFILE;
    }
  }

  public getProfile(): LearnedStyleProfile {
    return this.profile;
  }

  public saveProfile(profile: LearnedStyleProfile): void {
    this.profile = profile;
    writeFileSync(this.filePath, JSON.stringify(profile, null, 2), 'utf-8');
  }
}

export class PendingRepliesManager {
  private filePath: string;
  private replies: PendingSmartReply[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.loadReplies();
  }

  private loadReplies(): void {
    if (!existsSync(this.filePath)) {
      this.replies = [];
      return;
    }
    try {
      const data = readFileSync(this.filePath, 'utf-8');
      this.replies = JSON.parse(data) as PendingSmartReply[];
    } catch {
      this.replies = [];
    }
  }

  public getPendingReplies(): PendingSmartReply[] {
    return this.replies.filter((r) => r.status === 'pending');
  }

  public getAllReplies(): PendingSmartReply[] {
    return this.replies;
  }

  public addPendingReply(reply: Omit<PendingSmartReply, 'id' | 'createdAt' | 'status'>): PendingSmartReply {
    const existingIndex = this.replies.findIndex((r) => r.messageId === reply.messageId);
    const newRecord: PendingSmartReply = {
      ...reply,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    if (existingIndex >= 0) {
      this.replies[existingIndex] = newRecord;
    } else {
      this.replies.unshift(newRecord);
    }

    if (this.replies.length > 200) {
      this.replies = this.replies.slice(0, 200);
    }

    this.saveReplies();
    return newRecord;
  }

  public markAsDrafted(id: string): boolean {
    const record = this.replies.find((r) => r.id === id || r.messageId === id);
    if (!record) return false;
    record.status = 'drafted';
    this.saveReplies();
    return true;
  }

  public dismissReply(id: string): boolean {
    const record = this.replies.find((r) => r.id === id || r.messageId === id);
    if (!record) return false;
    record.status = 'dismissed';
    this.saveReplies();
    return true;
  }

  private saveReplies(): void {
    writeFileSync(this.filePath, JSON.stringify(this.replies, null, 2), 'utf-8');
  }
}

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

export const LLMStyleExtractionSchema = z.object({
  tone: z.string().describe('The authentic tone and communication voice of the user'),
  default_greetings: z.array(z.string()).describe('Exact greetings and salutations the user uses'),
  default_signoffs: z.array(z.string()).describe('Exact sign-offs and sign-out phrases the user uses'),
  average_length_words: z.number().describe('Typical word count of their email responses'),
  style_guidelines: z.array(z.string()).describe('3-5 specific behavioral guidelines describing how the user writes'),
  learned_templates: z
    .array(
      z.object({
        trigger: z.string().describe('Situation or question that triggers this template'),
        response_outline: z.string().describe('How the user typically structures this response'),
      })
    )
    .default([]),
});

export const LLMSmartReplySchema = z.object({
  should_reply: z.boolean().describe('True if this email thread requires a reply from the user'),
  reasoning: z.string().describe('Brief rationale explaining why a reply is or is not needed'),
  suggested_reply_text: z.string().describe('Contextual reply written in the user authentic voice'),
  confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1'),
});

export const distillStyleFromSentEmails = async (
  gmailClient: GmailClient,
  ollamaHost: string,
  modelName: string,
  limit = 50
): Promise<LearnedStyleProfile> => {
  const sentMessages = await gmailClient.listSentMessages(limit);
  if (sentMessages.length === 0) {
    return DEFAULT_STYLE_PROFILE;
  }

  const sampleEmails: string[] = [];
  for (const [index, msg] of sentMessages.entries()) {
    const headers = msg.payload?.headers ?? [];
    const subject = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? 'No Subject';
    const recipient = headers.find((h) => h.name?.toLowerCase() === 'to')?.value ?? 'Unknown';
    const bodyText = extractMessageBody(msg.payload);

    if (bodyText.length > 20) {
      sampleEmails.push(`[SENT EMAIL ${index + 1}]
To: ${recipient}
Subject: ${subject}

${bodyText.slice(0, 1500)}`);
    }
  }

  const client = new Ollama({ host: ollamaHost });
  const jsonSchema = zodToJsonSchema(LLMStyleExtractionSchema, 'StyleExtraction');

  const systemPrompt = `You are an elite communication analyst and stylist.
Your task is to analyze a corpus of real emails sent by the user, reverse-engineer their unique personal communication style, and produce an authentic style profile in structured JSON.

CRITICAL EXTRACTION REQUIREMENTS:
1. tone: The authentic voice, formality, and attitude (e.g. "Direct, casual-professional, helpful, warm, no-nonsense").
2. default_greetings: Exact greeting formats the user uses (e.g. ["Hi [Name],", "Morning,"]).
3. default_signoffs: Exact sign-offs and signatures the user signs with (e.g. ["Thanks,\nAaron", "Best regards,\nAaron"]).
4. average_length_words: Typical word count of their responses.
5. style_guidelines: 3-5 concise, specific behavioral rules that describe how the user writes (e.g. "Avoids opening pleasantries", "Uses bullet points for steps", "Keeps paragraphs to 1-2 sentences").
6. learned_templates: Any repeated response patterns observed across the emails.`;

  const userPrompt = `Here are ${sampleEmails.length} recent sent emails by the user:\n\n${sampleEmails.join('\n\n====================\n\n')}\n\nAnalyze these emails and output the complete Style Profile JSON.`;

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

  const rawParsed = parseJsonResponse<Record<string, unknown>>(response.message.content);
  const rawTemplates = rawParsed['learned_templates'] ?? rawParsed['learnedTemplates'];
  const safeTemplates = Array.isArray(rawTemplates) ? rawTemplates : [];

  const rawGreetings = rawParsed['default_greetings'] ?? rawParsed['defaultGreetings'];
  const safeGreetings = Array.isArray(rawGreetings) ? rawGreetings.map(String) : DEFAULT_STYLE_PROFILE.defaultGreetings;

  const rawSignoffs = rawParsed['default_signoffs'] ?? rawParsed['defaultSignoffs'];
  const safeSignoffs = Array.isArray(rawSignoffs) ? rawSignoffs.map(String) : DEFAULT_STYLE_PROFILE.defaultSignoffs;

  const rawGuidelines = rawParsed['style_guidelines'] ?? rawParsed['styleGuidelines'];
  const safeGuidelines = Array.isArray(rawGuidelines) ? rawGuidelines.map(String) : DEFAULT_STYLE_PROFILE.styleGuidelines;

  return {
    tone: String(rawParsed['tone'] ?? rawParsed['Tone'] ?? DEFAULT_STYLE_PROFILE.tone),
    defaultGreetings: safeGreetings,
    defaultSignoffs: safeSignoffs,
    averageLengthWords:
      typeof rawParsed['average_length_words'] === 'number'
        ? rawParsed['average_length_words']
        : typeof rawParsed['averageLengthWords'] === 'number'
          ? rawParsed['averageLengthWords']
          : DEFAULT_STYLE_PROFILE.averageLengthWords,
    styleGuidelines: safeGuidelines,
    learnedTemplates: safeTemplates.map((t: any) => ({
      trigger: String(t?.['trigger'] ?? ''),
      responseOutline: String(t?.['response_outline'] ?? t?.['responseOutline'] ?? ''),
    })),
    updatedAt: new Date().toISOString(),
  };
};

export const generateSmartReply = async (
  thread: ParsedEmailThread,
  styleProfile: LearnedStyleProfile,
  ollamaHost: string,
  modelName: string
): Promise<SmartReplyGeneration> => {
  const client = new Ollama({ host: ollamaHost });
  const jsonSchema = zodToJsonSchema(LLMSmartReplySchema, 'SmartReply');

  const greetingsStr = styleProfile.defaultGreetings.join(' OR ');
  const signoffsStr = styleProfile.defaultSignoffs.join(' OR ');
  const guidelinesStr = styleProfile.styleGuidelines.map((g) => `- ${g}`).join('\n');

  const systemPrompt = `You are a personalized Smart Reply Ghostwriter.
Your sole mission is to draft an email response to an incoming email thread written authentically in the USER'S PERSONAL WRITING VOICE.

USER WRITING PROFILE:
- Tone: ${styleProfile.tone}
- Preferred Greetings: ${greetingsStr}
- Preferred Sign-offs: ${signoffsStr}
- Target Length: ~${styleProfile.averageLengthWords} words
- Style Guidelines:
${guidelinesStr}

RULES:
1. Determine if this email genuinely requires a reply from the user (e.g. a question, request, invoice query, or scheduling confirmation).
2. If no reply is needed, set "should_reply" to false with empty suggested_reply_text.
3. If a reply is needed, draft a contextually accurate, natural response using the user's exact tone, greeting, and signature.
4. Output valid structured JSON.`;

  const latestMessage = thread.messages[thread.messages.length - 1];
  const sender = latestMessage?.sender ?? 'Unknown';
  const subject = latestMessage?.subject ?? thread.subject;

  const userPrompt = `INCOMING EMAIL THREAD:
From: ${sender}
Subject: ${subject}

${thread.fullConversationContext.slice(-6000)}

Draft the smart reply in the user's authentic style.`;

  const response = await client.chat({
    model: modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    format: jsonSchema as Record<string, unknown>,
    options: {
      temperature: 0.2,
    },
  });

  const rawReply = parseJsonResponse<Record<string, unknown>>(response.message.content);
  return {
    should_reply: Boolean(rawReply['should_reply'] ?? rawReply['shouldReply']),
    reasoning: String(rawReply['reasoning'] ?? ''),
    suggested_reply_text: String(rawReply['suggested_reply_text'] ?? rawReply['suggestedReplyText'] ?? ''),
    confidence: typeof rawReply['confidence'] === 'number' ? rawReply['confidence'] : 0.95,
  };
};
