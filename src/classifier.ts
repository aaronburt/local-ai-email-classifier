import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Ollama } from 'ollama';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  AttachmentSummarySchema,
  createClassificationSchema,
  createRemoteClassificationSchema,
  type AppConfig,
  type AttachmentSummary,
  type ClassificationResult,
  type CloudClassificationResult,
  type GmailUserLabel,
  type LearnedRule,
  type ParsedEmailThread,
  type RemoteClassificationResult,
  type UnmatchedEmailRecord,
} from './types.js';

export const DEFAULT_CLASSIFICATION_SYSTEM_PROMPT = `You are a privacy-first email classification assistant.
Your task is to analyze the email thread and choose the single most appropriate label from the list of allowed labels.

ALLOWED LABELS:
{{ALLOWED_LABELS}}{{LEARNED_RULES}}

RULES:
1. You must select strictly ONE label from the ALLOWED LABELS list above.
2. If none of the allowed labels accurately and specifically describe the email, set "selected_label" to null.
3. Never invent new labels that are not in the ALLOWED LABELS list.
4. Output your answer in structured JSON matching the requested schema.
5. Provide a confidence score between 0.0 and 1.0, a concise 1-sentence reasoning, and whether this email requires user action.`;

export const DEFAULT_REMOTE_ESCALATION_SYSTEM_PROMPT = `You are a senior email classification authority performing a deep review of an ambiguous email.
A fast local model was unable to classify this email with high confidence. You must:

1. Carefully analyze the FULL uncompressed email thread, headers, and attachments below.
2. Select strictly ONE label from the ALLOWED LABELS list.
3. Output structured JSON with: selected_label, confidence (0.0-1.0), reasoning (1 sentence), is_action_required (boolean).
4. ALSO output a "learned_rule" object with:
   - "sender_domain": the sender's email domain (e.g. "netflix.com")
   - "topic_condition": a short pattern description for when this rule applies (e.g. "recommendation emails with upcoming titles")
   - "target_label": the correct label for this pattern
   - "reasoning": a 1-sentence explanation of WHY this pattern maps to this label

ALLOWED LABELS:
{{ALLOWED_LABELS}}

IMPORTANT: The learned_rule you generate will be used to teach the fast local model so it can handle similar emails independently in the future.`;

export const DEFAULT_CLOUD_ESCALATION_SYSTEM_PROMPT = DEFAULT_REMOTE_ESCALATION_SYSTEM_PROMPT;

export const DEFAULT_ATTACHMENT_SUMMARY_SYSTEM_PROMPT = `You are a specialized Document Summarization Agent.
Your sole mission is to read raw document attachments (such as invoices, receipts, contracts, statements, or forms), crush the context down, and extract the key relevant parts of high importance.

CRITICAL EXTRACTION REQUIREMENTS:
1. Document Type: Identify the precise classification of this document (e.g., Utility Bill, Tax Invoice, Purchase Order, Return Shipping Label, Legal Addendum, Medical Report).
2. High-Importance Summary: A concise, information-dense executive summary of the document's core message or purpose.
3. Key Parties & Entities: Names of issuers, vendors, clients, employers, or recipients mentioned in the document.
4. Dates & Amounts: Any deadlines, payment due dates, statement dates, currency amounts, VAT/tax totals, or reference/tracking numbers.
5. Action Needed: Any mandatory next steps, payment obligations, signature requests, or reply requirements.

Always output strictly valid JSON conforming to the requested schema.`;

export class RuleManager {
  private filePath: string;
  private rules: LearnedRule[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.loadRules();
  }

  private loadRules(): void {
    if (!existsSync(this.filePath)) {
      this.rules = [];
      return;
    }
    try {
      const data = readFileSync(this.filePath, 'utf-8');
      this.rules = JSON.parse(data) as LearnedRule[];
    } catch {
      this.rules = [];
    }
  }

  public getActiveRules(): LearnedRule[] {
    return this.rules;
  }

  public addRule(rule: Omit<LearnedRule, 'id' | 'createdAt'>): LearnedRule {
    const existingIndex = this.rules.findIndex(
      (r) =>
        r.senderDomain.toLowerCase() === rule.senderDomain.toLowerCase() &&
        r.topicCondition.toLowerCase() === rule.topicCondition.toLowerCase()
    );

    const newRule: LearnedRule = {
      ...rule,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      this.rules[existingIndex] = newRule;
    } else {
      this.rules.push(newRule);
    }

    this.saveRules();
    return newRule;
  }

  private saveRules(): void {
    writeFileSync(this.filePath, JSON.stringify(this.rules, null, 2), 'utf-8');
  }
}

export class UnmatchedManager {
  private filePath: string;
  private records: UnmatchedEmailRecord[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.loadRecords();
  }

  private loadRecords(): void {
    if (!existsSync(this.filePath)) {
      this.records = [];
      return;
    }
    try {
      const data = readFileSync(this.filePath, 'utf-8');
      this.records = JSON.parse(data) as UnmatchedEmailRecord[];
    } catch {
      this.records = [];
    }
  }

  public getRecords(): UnmatchedEmailRecord[] {
    return this.records;
  }

  public addRecord(record: UnmatchedEmailRecord): void {
    const exists = this.records.some((r) => r.threadId === record.threadId);
    if (!exists) {
      this.records.push(record);
      this.saveRecords();
    }
  }

  public recordUnmatched(
    thread: ParsedEmailThread,
    confidence: number,
    reasoning: string
  ): void {
    const latestMessage = thread.messages[thread.messages.length - 1];
    this.addRecord({
      id: latestMessage?.id ?? thread.threadId,
      threadId: thread.threadId,
      subject: latestMessage?.subject ?? thread.subject,
      sender: latestMessage?.sender ?? 'Unknown',
      date: latestMessage?.date ?? new Date().toISOString(),
      confidence,
      reasoning,
      unmatchedAt: new Date().toISOString(),
    });
  }

  private saveRecords(): void {
    writeFileSync(this.filePath, JSON.stringify(this.records, null, 2), 'utf-8');
  }
}

export const buildClassificationPrompt = (
  thread: ParsedEmailThread,
  availableLabels: GmailUserLabel[],
  labelHints: Record<string, string> = {},
  learnedRules: LearnedRule[] = [],
  customSystemTemplate?: string
): { systemPrompt: string; userPrompt: string } => {
  const formattedLabels = availableLabels
    .map((label) => {
      const hint = labelHints[label.name];
      return hint ? `- "${label.name}": ${hint}` : `- "${label.name}"`;
    })
    .join('\n');

  const formattedRules =
    learnedRules.length > 0
      ? `\n\nLEARNED DISAMBIGUATION RULES (Prioritize these patterns):\n` +
        learnedRules
          .map(
            (r) =>
              `- From *@${r.senderDomain} when "${r.topicCondition}" → Label: "${r.targetLabel}" (${r.reasoning})`
          )
          .join('\n')
      : '';

  const template = customSystemTemplate && customSystemTemplate.trim().length > 0
    ? customSystemTemplate
    : DEFAULT_CLASSIFICATION_SYSTEM_PROMPT;

  const systemPrompt = template
    .replace('{{ALLOWED_LABELS}}', formattedLabels)
    .replace('{{LEARNED_RULES}}', formattedRules);

  const messagesText = formatThreadMessages(thread);
  const userPrompt = `Classify this email thread:\n\n${messagesText}`;

  return { systemPrompt, userPrompt };
};

export const buildRemoteEscalationPrompt = (
  thread: ParsedEmailThread,
  availableLabels: GmailUserLabel[],
  labelHints: Record<string, string> = {},
  tier1Notes: string,
  customSystemTemplate?: string
): { systemPrompt: string; userPrompt: string } => {
  const formattedLabels = availableLabels
    .map((label) => {
      const hint = labelHints[label.name];
      return hint ? `- "${label.name}": ${hint}` : `- "${label.name}"`;
    })
    .join('\n');

  const template = customSystemTemplate && customSystemTemplate.trim().length > 0
    ? customSystemTemplate
    : DEFAULT_REMOTE_ESCALATION_SYSTEM_PROMPT;

  const systemPrompt = template.replace('{{ALLOWED_LABELS}}', formattedLabels);

  const messagesText = formatThreadMessages(thread);
  const userPrompt = `TIER 1 LOCAL MODEL NOTES:\n${tier1Notes}\n\nFULL EMAIL THREAD FOR DEEP REVIEW:\n\n${messagesText}`;

  return { systemPrompt, userPrompt };
};

export const buildCloudEscalationPrompt = buildRemoteEscalationPrompt;

const formatThreadMessages = (thread: ParsedEmailThread): string => {
  return thread.messages
    .map((message, index) => {
      const header = `[MESSAGE ${index + 1} OF ${thread.messages.length}]
From: ${message.sender}
To: ${message.recipient}
Date: ${message.date}
Subject: ${message.subject}`;

      const attachmentInfo =
        message.attachments.length > 0
          ? `\nAttachments:\n${message.attachments
              .map((att) => (att.extractedText ? `File: ${att.filename}\nContent:\n${att.extractedText}` : `File: ${att.filename}`))
              .join('\n\n')}`
          : '';

      return `${header}\n\nBody:\n${message.cleanBody}${attachmentInfo}`;
    })
    .join('\n\n========================================\n\n');
};

const parseJsonPayload = (content: string): unknown => {
  const trimmed = content.trim();
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const rawJson = jsonMatch ? jsonMatch[1] : trimmed;
  return JSON.parse(rawJson ?? trimmed);
};

export class LLMEngine {
  private client: Ollama;
  private remoteClient?: Ollama;
  private host: string;
  private model: string;
  private remoteModel?: string;
  private remoteHost?: string;
  private contextWindow: number;
  private temperature: number;
  private keepAlive: string | number;
  private labelHints: Record<string, string>;
  private prompts?: AppConfig['prompts'];

  constructor(options: {
    host: string;
    model: string;
    remoteModel?: string;
    remoteHost?: string;
    cloudModel?: string;
    contextWindow: number;
    temperature: number;
    keepAlive: string | number;
    labelHints: Record<string, string>;
    prompts?: AppConfig['prompts'];
  }) {
    this.host = options.host;
    this.model = options.model;
    this.remoteModel = options.remoteModel ?? options.cloudModel;
    this.remoteHost = options.remoteHost;
    this.contextWindow = options.contextWindow;
    this.temperature = options.temperature;
    this.keepAlive = options.keepAlive;
    this.labelHints = options.labelHints;
    this.prompts = options.prompts;
    this.client = new Ollama({ host: this.host });
    if (this.remoteHost && this.remoteHost !== this.host) {
      this.remoteClient = new Ollama({ host: this.remoteHost });
    }
  }

  async classifyThread(
    thread: ParsedEmailThread,
    availableLabels: GmailUserLabel[],
    learnedRules: LearnedRule[] = []
  ): Promise<ClassificationResult> {
    const labelNames = availableLabels.map((l) => l.name);
    const zodSchema = createClassificationSchema(labelNames);
    const jsonSchema = zodToJsonSchema(zodSchema, 'ClassificationResponse');

    const { systemPrompt, userPrompt } = buildClassificationPrompt(
      thread,
      availableLabels,
      this.labelHints,
      learnedRules,
      this.prompts?.classificationSystem
    );

    const response = await this.client.chat({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      format: jsonSchema as Record<string, unknown>,
      keep_alive: this.keepAlive,
      options: {
        temperature: this.temperature,
        num_ctx: this.contextWindow,
      },
    });

    const parsedJson = parseJsonPayload(response.message.content);
    return zodSchema.parse(parsedJson);
  }

  async classifyWithRemote(
    thread: ParsedEmailThread,
    availableLabels: GmailUserLabel[],
    tier1Notes: string
  ): Promise<RemoteClassificationResult> {
    if (!this.remoteModel) {
      throw new Error('No remote model configured');
    }

    const labelNames = availableLabels.map((l) => l.name);
    const zodSchema = createRemoteClassificationSchema(labelNames);
    const jsonSchema = zodToJsonSchema(zodSchema, 'RemoteClassificationResponse');

    const { systemPrompt, userPrompt } = buildRemoteEscalationPrompt(
      thread,
      availableLabels,
      this.labelHints,
      tier1Notes,
      this.prompts?.remoteEscalationSystem ?? this.prompts?.cloudEscalationSystem
    );

    const client = this.remoteClient ?? this.client;
    const response = await client.chat({
      model: this.remoteModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      format: jsonSchema as Record<string, unknown>,
      keep_alive: this.keepAlive,
      options: {
        temperature: this.temperature,
      },
    });

    const parsedJson = parseJsonPayload(response.message.content);
    return zodSchema.parse(parsedJson);
  }

  async classifyWithCloud(
    thread: ParsedEmailThread,
    availableLabels: GmailUserLabel[],
    tier1Notes: string
  ): Promise<CloudClassificationResult> {
    return this.classifyWithRemote(thread, availableLabels, tier1Notes);
  }

  async summarizeAttachment(
    filename: string,
    mimeType: string,
    rawDocumentText: string
  ): Promise<string> {
    const jsonSchema = zodToJsonSchema(AttachmentSummarySchema, 'DocumentSummary');
    const systemPrompt = this.prompts?.attachmentSummarySystem && this.prompts.attachmentSummarySystem.trim().length > 0
      ? this.prompts.attachmentSummarySystem
      : DEFAULT_ATTACHMENT_SUMMARY_SYSTEM_PROMPT;

    const userPrompt = `ATTACHMENT METADATA:
- File Name: ${filename}
- MIME Type: ${mimeType}

RAW DOCUMENT CONTENT:
${rawDocumentText}`;

    const response = await this.client.chat({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      format: jsonSchema as Record<string, unknown>,
      keep_alive: this.keepAlive,
      options: {
        temperature: this.temperature,
        num_ctx: this.contextWindow,
      },
    });

    const parsed: AttachmentSummary = AttachmentSummarySchema.parse(
      parseJsonPayload(response.message.content)
    );
    const entities = parsed.key_parties_or_entities.join(', ');
    const datesAmounts = parsed.dates_and_amounts.join(', ');

    return `[DOCUMENT SUMMARY: ${filename}]
Type: ${parsed.document_type}
Summary: ${parsed.summary}
Key Entities: ${entities || 'None'}
Dates & Amounts: ${datesAmounts || 'None'}
Action Needed: ${parsed.action_needed ?? 'None'}`;
  }

  async unloadModel(): Promise<void> {
    const modelsToUnload = [this.model].filter(Boolean);
    for (const model of modelsToUnload) {
      try {
        await this.client.generate({
          model,
          prompt: '',
          keep_alive: 0,
        });
      } catch {
        // Model already unloaded or is remote
      }
    }
  }
}
