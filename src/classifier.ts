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

export const DEFAULT_REMOTE_ESCALATION_SYSTEM_PROMPT = `You are a senior email classification authority and algorithmic rule synthesizer.
A fast local model was unable to classify this email with high confidence. You must:

1. Carefully analyze the FULL uncompressed email thread, headers, and attachments below.
2. Select strictly ONE label from the ALLOWED LABELS list.
3. Output structured JSON with: selected_label, confidence (0.0-1.0), reasoning (1 sentence), is_action_required (boolean).
4. ALSO synthesize a high-precision, deterministic "learned_rule" object:
   - "sender_domain": the sender's clean root email domain (e.g. "amazon.co.uk", "stripe.com", "github.com")
   - "sender_regex": optional regex for sender local-part/subaddress (e.g. "^(auto-confirm|receipts|no-reply)@")
   - "subject_pattern": invariant regex matching the subject template with transient variables (dates, amounts, order numbers) wildcarded (e.g. "^(?:Your order of|Order Confirmation|Receipt for)\\\\b.*")
   - "exclude_pattern": optional negative regex pattern to reject marketing campaigns, promotions, or newsletters sent from the same domain (e.g. "(?:deal|discount|newsletter|sale|promo|recommend)")
   - "target_label": the correct label name
   - "reasoning": 1-sentence technical explanation of why this structural invariant pattern accurately classifies this email type

IMPORTANT RULE SYNTHESIS RULES:
- Never make broad domain-only rules for multi-purpose providers (like Amazon, Google, Apple, Microsoft, PayPal). Always qualify with sender prefix and subject keywords.
- Never include exact dates, exact prices, or 12+ digit specific order IDs. Use regex wildcards like \\\\d+, [A-Z0-9-]+, or \\\\b.
- The rule must accurately match this email AND all future emails of this exact category.

ALLOWED LABELS:
{{ALLOWED_LABELS}}`;

export const DEFAULT_ATTACHMENT_SUMMARY_SYSTEM_PROMPT = `You are a specialized Document Summarization Agent.
Your sole mission is to read raw document attachments (such as invoices, receipts, contracts, statements, or forms), crush the context down, and extract the key relevant parts of high importance.

CRITICAL EXTRACTION REQUIREMENTS:
1. Document Type: Identify the precise classification of this document (e.g., Utility Bill, Tax Invoice, Purchase Order, Return Shipping Label, Legal Addendum, Medical Report).
2. High-Importance Summary: A concise, information-dense executive summary of the document's core message or purpose.
3. Key Parties & Entities: Names of issuers, vendors, clients, employers, or recipients mentioned in the document.
4. Dates & Amounts: Any deadlines, payment due dates, statement dates, currency amounts, VAT/tax totals, or reference/tracking numbers.
5. Action Needed: Any mandatory next steps, payment obligations, signature requests, or reply requirements.

Always output strictly valid JSON conforming to the requested schema.`;

interface CompiledRule {
  rule: LearnedRule;
  senderRegex?: RegExp;
  subjectRegex?: RegExp;
  excludeRegex?: RegExp;
}

export class RuleManager {
  private filePath: string;
  private rules: LearnedRule[] = [];
  private compiledRules: CompiledRule[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.loadRules();
  }

  private loadRules(): void {
    if (!existsSync(this.filePath)) {
      this.rules = [];
      this.compiledRules = [];
      return;
    }
    try {
      const data = readFileSync(this.filePath, 'utf-8');
      this.rules = JSON.parse(data) as LearnedRule[];
    } catch {
      this.rules = [];
    }
    this.recompile();
  }

  private recompile(): void {
    this.compiledRules = this.rules.map((rule) => {
      let senderRegex: RegExp | undefined;
      let subjectRegex: RegExp | undefined;
      let excludeRegex: RegExp | undefined;

      if (rule.senderRegex) {
        try {
          senderRegex = new RegExp(rule.senderRegex, 'i');
        } catch {}
      }

      if (rule.subjectPattern) {
        try {
          subjectRegex = new RegExp(rule.subjectPattern, 'i');
        } catch {}
      }

      if (rule.excludePattern) {
        try {
          excludeRegex = new RegExp(rule.excludePattern, 'i');
        } catch {}
      }

      return { rule, senderRegex, subjectRegex, excludeRegex };
    });
  }

  public getActiveRules(): LearnedRule[] {
    return this.rules;
  }

  public evaluate(
    sender: string,
    subject: string,
    snippet?: string
  ): { rule: LearnedRule; confidence: number } | undefined {
    const emailMatch = sender.match(/@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const domain = emailMatch && emailMatch[1] ? emailMatch[1].toLowerCase() : '';
    if (!domain) return undefined;

    const fullSubjectAndSnippet = `${subject} ${snippet ?? ''}`.trim();

    // 1. Check compiled algorithmic rules first (highest precision)
    for (const entry of this.compiledRules) {
      const r = entry.rule;
      const targetDomain = r.senderDomain.toLowerCase();
      const domainMatches = domain === targetDomain || domain.endsWith(`.${targetDomain}`);
      if (!domainMatches) continue;

      // Check sender regex if present
      if (entry.senderRegex && !entry.senderRegex.test(sender)) {
        continue;
      }

      // Check subject pattern if present
      if (entry.subjectRegex && !entry.subjectRegex.test(subject) && !entry.subjectRegex.test(fullSubjectAndSnippet)) {
        continue;
      }

      // Check negative exclusion pattern if present
      if (entry.excludeRegex && (entry.excludeRegex.test(subject) || entry.excludeRegex.test(fullSubjectAndSnippet))) {
        continue;
      }

      // If it has at least subjectPattern or senderRegex, it's an algorithmic match
      if (r.subjectPattern || r.senderRegex) {
        r.hitCount = (r.hitCount ?? 0) + 1;
        r.lastMatchedAt = new Date().toISOString();
        this.saveRules();
        return { rule: r, confidence: 1.0 };
      }
    }

    // 2. Legacy fallback for simple domain rules where all domain rules agree
    const matchingLegacyRules = this.rules.filter(
      (r) => !r.subjectPattern && !r.senderRegex && (domain === r.senderDomain.toLowerCase() || domain.endsWith(`.${r.senderDomain.toLowerCase()}`))
    );

    if (matchingLegacyRules.length > 0) {
      const firstLabel = matchingLegacyRules[0]?.targetLabel;
      const allAgree = matchingLegacyRules.every((r) => r.targetLabel === firstLabel);
      if (allAgree && matchingLegacyRules[0]) {
        matchingLegacyRules[0].hitCount = (matchingLegacyRules[0].hitCount ?? 0) + 1;
        matchingLegacyRules[0].lastMatchedAt = new Date().toISOString();
        this.saveRules();
        return { rule: matchingLegacyRules[0], confidence: 1.0 };
      }
    }

    return undefined;
  }

  public validateAndAddRule(
    ruleCandidate: {
      sender_domain: string;
      sender_regex?: string | null;
      subject_pattern?: string | null;
      topic_condition?: string;
      exclude_pattern?: string | null;
      target_label: string;
      reasoning: string;
    },
    sampleEmail?: { sender: string; subject: string }
  ): LearnedRule | null {
    // 1. Verify regex syntax
    let senderRegex: RegExp | undefined;
    let subjectRegex: RegExp | undefined;
    let excludeRegex: RegExp | undefined;

    if (ruleCandidate.sender_regex) {
      try {
        senderRegex = new RegExp(ruleCandidate.sender_regex, 'i');
      } catch {
        return null;
      }
    }

    if (ruleCandidate.subject_pattern) {
      try {
        subjectRegex = new RegExp(ruleCandidate.subject_pattern, 'i');
      } catch {
        return null;
      }
    }

    if (ruleCandidate.exclude_pattern) {
      try {
        excludeRegex = new RegExp(ruleCandidate.exclude_pattern, 'i');
      } catch {
        return null;
      }
    }

    // 2. Self-test against sample email if provided
    if (sampleEmail) {
      const emailDomainMatch = sampleEmail.sender.match(/@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      const emailDomain = emailDomainMatch && emailDomainMatch[1] ? emailDomainMatch[1].toLowerCase() : '';
      const candidateDomain = ruleCandidate.sender_domain.toLowerCase();

      const domainOk = emailDomain === candidateDomain || emailDomain.endsWith(`.${candidateDomain}`);
      if (!domainOk) return null;

      if (senderRegex && !senderRegex.test(sampleEmail.sender)) {
        return null;
      }

      if (subjectRegex && !subjectRegex.test(sampleEmail.subject)) {
        return null;
      }

      if (excludeRegex && excludeRegex.test(sampleEmail.subject)) {
        return null;
      }
    }

    // 3. Invariant check: reject raw 12+ digit random order IDs or raw ISO dates without wildcarding
    if (
      ruleCandidate.subject_pattern &&
      (/\b\d{12,}\b/.test(ruleCandidate.subject_pattern) || /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(ruleCandidate.subject_pattern))
    ) {
      return null;
    }

    // 4. Upsert rule
    const existingIndex = this.rules.findIndex(
      (r) =>
        r.senderDomain.toLowerCase() === ruleCandidate.sender_domain.toLowerCase() &&
        (ruleCandidate.subject_pattern ? r.subjectPattern === ruleCandidate.subject_pattern : r.topicCondition === ruleCandidate.topic_condition)
    );

    const newRule: LearnedRule = {
      id: existingIndex >= 0 ? this.rules[existingIndex]?.id ?? randomUUID() : randomUUID(),
      senderDomain: ruleCandidate.sender_domain.toLowerCase().trim(),
      senderRegex: ruleCandidate.sender_regex ?? undefined,
      subjectPattern: ruleCandidate.subject_pattern ?? undefined,
      topicCondition: ruleCandidate.topic_condition ?? undefined,
      excludePattern: ruleCandidate.exclude_pattern ?? undefined,
      targetLabel: ruleCandidate.target_label,
      reasoning: ruleCandidate.reasoning,
      createdAt: existingIndex >= 0 ? this.rules[existingIndex]?.createdAt ?? new Date().toISOString() : new Date().toISOString(),
      hitCount: existingIndex >= 0 ? this.rules[existingIndex]?.hitCount : 1,
      lastMatchedAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      this.rules[existingIndex] = newRule;
    } else {
      this.rules.unshift(newRule);
    }

    this.saveRules();
    this.recompile();
    return newRule;
  }

  public saveRules(): void {
    writeFileSync(this.filePath, JSON.stringify(this.rules, null, 2), 'utf-8');
    this.recompile();
  }
}

export const upgradeLegacyRules = async (
  ruleManager: RuleManager,
  ollamaHost: string,
  modelName: string,
  onProgress?: (msg: string) => void
): Promise<{ upgradedCount: number }> => {
  const client = new Ollama({ host: ollamaHost });
  const allRules = ruleManager.getActiveRules();
  const legacyRules = allRules.filter((r) => !r.subjectPattern && Boolean(r.topicCondition));

  if (legacyRules.length === 0) {
    return { upgradedCount: 0 };
  }

  onProgress?.(`Found ${legacyRules.length} rule(s) to augment with algorithmic regex patterns using "${modelName}"...`);

  const directSchema = {
    type: 'object',
    properties: {
      upgrades: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            sender_regex: { type: 'string' },
            subject_pattern: { type: 'string' },
            exclude_pattern: { type: 'string' },
          },
          required: ['id', 'subject_pattern'],
        },
      },
    },
    required: ['upgrades'],
  };

  const BATCH_SIZE = 5;
  let totalUpgraded = 0;

  for (let i = 0; i < legacyRules.length; i += BATCH_SIZE) {
    const chunk = legacyRules.slice(i, i + BATCH_SIZE);
    const prompt = `You are a regular expression compiler for an email classification engine.
Your mission is to synthesize high-precision JavaScript regular expressions from human-readable topic conditions while PRESERVING the existing rule topics.

RULES FOR REGEX SYNTHESIS:
1. "subject_pattern": An invariant regex matching the subject template with wildcards for dates, amounts, and numbers (e.g. "^(?:Cron|vzdump|Account Verification)\\\\b.*" or ".*(?:statement|invoice|receipt).*").
2. "sender_regex": Optional prefix/subaddress regex if specific to an address (e.g. "^(?:no-reply|billing|root)@").
3. "exclude_pattern": Optional negative regex if promotions/newsletters must be rejected (e.g. "(?:deal|discount|newsletter)").
4. Ensure valid regex syntax with proper double-escaping in JSON.

RULES TO AUGMENT:
${JSON.stringify(
  chunk.map((r) => ({
    id: r.id,
    domain: r.senderDomain,
    targetLabel: r.targetLabel,
    topicCondition: r.topicCondition,
    reasoning: r.reasoning,
  })),
  null,
  2
)}`;

    try {
      const response = await client.chat({
        model: modelName,
        messages: [
          { role: 'system', content: 'Output valid JSON conforming to the schema with synthesized regex patterns for each rule id.' },
          { role: 'user', content: prompt },
        ],
        format: directSchema as Record<string, unknown>,
        options: { temperature: 0.1 },
      });

      const rawParsed = parseJsonPayload(response.message.content) as Record<string, unknown>;
      let upgradeList: Array<{
        id: string;
        sender_regex?: string | null;
        subject_pattern?: string | null;
        exclude_pattern?: string | null;
      }> = [];

      if (Array.isArray(rawParsed)) {
        upgradeList = rawParsed;
      } else if (rawParsed && Array.isArray(rawParsed['upgrades'])) {
        upgradeList = rawParsed['upgrades'] as typeof upgradeList;
      } else if (rawParsed && typeof rawParsed === 'object') {
        upgradeList = Object.entries(rawParsed).map(([key, val]) => {
          const v = val as Record<string, unknown>;
          return {
            id: (v['id'] as string) ?? key,
            sender_regex: (v['sender_regex'] as string) ?? null,
            subject_pattern: (v['subject_pattern'] as string) ?? null,
            exclude_pattern: (v['exclude_pattern'] as string) ?? null,
          };
        });
      }

      for (const item of upgradeList) {
        const rule = allRules.find((r) => r.id === item.id);
        if (!rule || !item.subject_pattern) continue;

        // Test regex validity
        try {
          new RegExp(item.subject_pattern, 'i');
          if (item.sender_regex) new RegExp(item.sender_regex, 'i');
          if (item.exclude_pattern) new RegExp(item.exclude_pattern, 'i');
        } catch {
          continue;
        }

        // Attach algorithmic fields while preserving topicCondition and reasoning
        rule.subjectPattern = item.subject_pattern;
        if (item.sender_regex) rule.senderRegex = item.sender_regex;
        if (item.exclude_pattern) rule.excludePattern = item.exclude_pattern;
        rule.lastMatchedAt = new Date().toISOString();
        totalUpgraded += 1;
      }

      ruleManager.saveRules();
      onProgress?.(`Processed ${Math.min(i + BATCH_SIZE, legacyRules.length)}/${legacyRules.length} rules (${totalUpgraded} augmented)...`);
    } catch (err) {
      onProgress?.(`Error augmenting batch: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  ruleManager.saveRules();
  return { upgradedCount: totalUpgraded };
};

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
          .slice(0, 50)
          .map((r) => {
            const pattern = r.subjectPattern ? ` matching /${r.subjectPattern}/` : r.topicCondition ? ` when "${r.topicCondition}"` : '';
            return `- From *@${r.senderDomain}${pattern} → Label: "${r.targetLabel}" (${r.reasoning})`;
          })
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

const MAX_BODY_CHARS = 8000;

const truncateBody = (body: string, maxChars = MAX_BODY_CHARS): string => {
  if (body.length <= maxChars) return body;
  const headSize = Math.floor(maxChars * 0.75);
  const tailSize = Math.floor(maxChars * 0.25);
  const omitted = body.length - headSize - tailSize;
  return `${body.slice(0, headSize)}\n\n[... ${omitted.toLocaleString()} characters truncated for context limit ...]\n\n${body.slice(-tailSize)}`;
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

      return `${header}\n\nBody:\n${truncateBody(message.cleanBody)}${attachmentInfo}`;
    })
    .join('\n\n========================================\n\n');
};

const parseJsonPayload = (content: string): unknown => {
  const trimmed = content.trim();
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const rawJson = jsonMatch ? jsonMatch[1] : trimmed;
  try {
    return JSON.parse(rawJson ?? trimmed);
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {}
    }
    const firstBracket = trimmed.indexOf('[');
    const lastBracket = trimmed.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      try {
        return JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
      } catch {}
    }
    throw new Error(`Failed to parse JSON: ${trimmed.slice(0, 100)}...`);
  }
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
