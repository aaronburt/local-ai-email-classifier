import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Ollama } from 'ollama';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  AttachmentSummarySchema,
  createClassificationSchema,
  createCloudClassificationSchema,
  type AppConfig,
  type AttachmentSummary,
  type ClassificationResult,
  type CloudClassificationResult,
  type GmailUserLabel,
  type LearnedRule,
  type ParsedEmailThread,
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

export const DEFAULT_CLOUD_ESCALATION_SYSTEM_PROMPT = `You are a senior email classification authority performing a deep review of an ambiguous email.
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
  private rules: LearnedRule[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  getActiveRules(): LearnedRule[] {
    return this.rules;
  }

  addRule(rule: Omit<LearnedRule, 'id' | 'createdAt'>): LearnedRule {
    const existingIndex = this.rules.findIndex(
      (r) => r.senderDomain === rule.senderDomain && r.targetLabel === rule.targetLabel
    );

    const fullRule: LearnedRule = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...rule,
    };

    if (existingIndex >= 0) {
      this.rules[existingIndex] = fullRule;
    } else {
      this.rules.push(fullRule);
    }

    this.save();
    return fullRule;
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.rules = [];
      return;
    }
    try {
      const content = readFileSync(this.filePath, 'utf-8');
      if (content.trim().length === 0) {
        this.rules = [];
        return;
      }
      this.rules = JSON.parse(content) as LearnedRule[];
    } catch {
      this.rules = [];
    }
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.rules, null, 2), 'utf-8');
    } catch {
      // Failed to persist learned rules
    }
  }
}

export class UnmatchedManager {
  private records: UnmatchedEmailRecord[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  getRecords(): UnmatchedEmailRecord[] {
    return this.records;
  }

  addRecord(record: UnmatchedEmailRecord): void {
    const existingIndex = this.records.findIndex((r) => r.id === record.id);
    if (existingIndex >= 0) {
      this.records[existingIndex] = record;
    } else {
      this.records.push(record);
    }
    this.save();
  }

  clear(): void {
    this.records = [];
    this.save();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.records = [];
      return;
    }
    try {
      const content = readFileSync(this.filePath, 'utf-8');
      if (content.trim().length === 0) {
        this.records = [];
        return;
      }
      const parsed = JSON.parse(content) as unknown;
      if (Array.isArray(parsed)) {
        this.records = parsed.map((item) => {
          if (typeof item === 'string') {
            return {
              id: item,
              threadId: item,
              subject: 'Unknown',
              sender: 'Unknown',
              date: new Date().toISOString(),
              confidence: 0,
              reasoning: 'Legacy ID entry',
              unmatchedAt: new Date().toISOString(),
            };
          }
          return item as UnmatchedEmailRecord;
        });
      } else {
        this.records = [];
      }
    } catch {
      this.records = [];
    }
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.records, null, 2), 'utf-8');
    } catch {
      return;
    }
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

  const learnedRulesSection = learnedRules.length > 0
    ? `\n\nLEARNED DISAMBIGUATION RULES (apply these with high priority):\n${learnedRules.map((rule) => `- Sender domain "${rule.senderDomain}" with topic "${rule.topicCondition}" → classify as "${rule.targetLabel}". Reason: ${rule.reasoning}`).join('\n')}`
    : '';

  const template = customSystemTemplate && customSystemTemplate.trim().length > 0
    ? customSystemTemplate
    : DEFAULT_CLASSIFICATION_SYSTEM_PROMPT;

  const systemPrompt = template
    .replace('{{ALLOWED_LABELS}}', formattedLabels)
    .replace('{{LEARNED_RULES}}', learnedRulesSection);

  const messagesText = formatThreadMessages(thread);
  const userPrompt = `Classify this email thread:\n\n${messagesText}`;

  return { systemPrompt, userPrompt };
};

export const buildCloudEscalationPrompt = (
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
    : DEFAULT_CLOUD_ESCALATION_SYSTEM_PROMPT;

  const systemPrompt = template.replace('{{ALLOWED_LABELS}}', formattedLabels);

  const messagesText = formatThreadMessages(thread);
  const userPrompt = `TIER 1 LOCAL MODEL NOTES:\n${tier1Notes}\n\nFULL EMAIL THREAD FOR DEEP REVIEW:\n\n${messagesText}`;

  return { systemPrompt, userPrompt };
};

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
  private host: string;
  private model: string;
  private cloudModel?: string;
  private contextWindow: number;
  private temperature: number;
  private keepAlive: string | number;
  private labelHints: Record<string, string>;
  private prompts?: AppConfig['prompts'];

  constructor(options: {
    host: string;
    model: string;
    cloudModel?: string;
    contextWindow: number;
    temperature: number;
    keepAlive: string | number;
    labelHints: Record<string, string>;
    prompts?: AppConfig['prompts'];
  }) {
    this.host = options.host;
    this.model = options.model;
    this.cloudModel = options.cloudModel;
    this.contextWindow = options.contextWindow;
    this.temperature = options.temperature;
    this.keepAlive = options.keepAlive;
    this.labelHints = options.labelHints;
    this.prompts = options.prompts;
    this.client = new Ollama({ host: this.host });
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

  async classifyWithCloud(
    thread: ParsedEmailThread,
    availableLabels: GmailUserLabel[],
    tier1Notes: string
  ): Promise<CloudClassificationResult> {
    if (!this.cloudModel) {
      throw new Error('No cloud model configured');
    }

    const labelNames = availableLabels.map((l) => l.name);
    const zodSchema = createCloudClassificationSchema(labelNames);
    const jsonSchema = zodToJsonSchema(zodSchema, 'CloudClassificationResponse');

    const { systemPrompt, userPrompt } = buildCloudEscalationPrompt(
      thread,
      availableLabels,
      this.labelHints,
      tier1Notes,
      this.prompts?.cloudEscalationSystem
    );

    const response = await this.client.chat({
      model: this.cloudModel,
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
        // Model already unloaded or is a cloud model
      }
    }
  }
}
