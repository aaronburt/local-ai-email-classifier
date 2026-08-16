import { z } from 'zod';

export interface AppConfig {
  ollama: {
    host: string;
    model: string;
    contextWindow: number;
    temperature: number;
    keepAlive: string | number;
    cloudModel?: string;
  };
  gmail: {
    credentialsPath: string;
    tokenPath: string;
    searchQuery: string;
    fallbackLabelName: string;
    batchSize: number;
    oauthPort: number;
    autoArchiveLabels: string[];
    autoMarkReadLabels: string[];
  };
  classification: {
    minConfidenceThreshold: number;
    escalationThreshold: number;
    learnedRulesPath: string;
    unmatchedPath: string;
    historyPath: string;
    labelHints: Record<string, string>;
  };
  prompts?: {
    classificationSystem?: string;
    cloudEscalationSystem?: string;
    attachmentSummarySystem?: string;
  };
}

export type PartialAppConfig = {
  [K in keyof AppConfig]?: Partial<AppConfig[K]>;
};

export interface LearnedRule {
  id: string;
  senderDomain: string;
  topicCondition: string;
  targetLabel: string;
  reasoning: string;
  createdAt: string;
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  extractedText?: string;
}

export interface ParsedEmailMessage {
  id: string;
  threadId: string;
  sender: string;
  recipient: string;
  subject: string;
  date: string;
  cleanBody: string;
  attachments: EmailAttachment[];
  labelIds: string[];
}

export interface ParsedEmailThread {
  threadId: string;
  subject: string;
  messages: ParsedEmailMessage[];
  fullConversationContext: string;
}

export interface GmailUserLabel {
  id: string;
  name: string;
  type: string;
}

export const createClassificationSchema = (allowedLabels: readonly string[]) => {
  const firstLabel = allowedLabels[0];
  if (!firstLabel) {
    return z.object({
      selected_label: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      reasoning: z.string(),
      is_action_required: z.boolean(),
    });
  }

  const confidenceSchema = z.number().transform((val) => {
    if (val > 1) return Math.min(val / 100, 1.0);
    return Math.max(0, Math.min(val, 1.0));
  });

  const labelEnum = z.enum([firstLabel, ...allowedLabels.slice(1)] as [string, ...string[]]);

  return z.object({
    selected_label: labelEnum.nullable(),
    confidence: confidenceSchema,
    reasoning: z.string(),
    is_action_required: z.boolean(),
  });
};

export const createCloudClassificationSchema = (allowedLabels: readonly string[]) => {
  const firstLabel = allowedLabels[0];
  if (!firstLabel) {
    return z.object({
      selected_label: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      reasoning: z.string(),
      is_action_required: z.boolean(),
      learned_rule: z.object({
        sender_domain: z.string(),
        topic_condition: z.string(),
        target_label: z.string(),
        reasoning: z.string(),
      }).optional(),
    });
  }

  const confidenceSchema = z.number().transform((val) => {
    if (val > 1) return Math.min(val / 100, 1.0);
    return Math.max(0, Math.min(val, 1.0));
  });

  const labelEnum = z.enum([firstLabel, ...allowedLabels.slice(1)] as [string, ...string[]]);

  return z.object({
    selected_label: labelEnum.nullable(),
    confidence: confidenceSchema,
    reasoning: z.string(),
    is_action_required: z.boolean(),
    learned_rule: z.object({
      sender_domain: z.string(),
      topic_condition: z.string(),
      target_label: z.string(),
      reasoning: z.string(),
    }).optional(),
  });
};

export interface ClassificationResult {
  selected_label: string | null;
  confidence: number;
  reasoning: string;
  is_action_required: boolean;
}

export interface CloudClassificationResult extends ClassificationResult {
  learned_rule?: {
    sender_domain: string;
    topic_condition: string;
    target_label: string;
    reasoning: string;
  };
}

export const AttachmentSummarySchema = z.object({
  document_type: z.string(),
  summary: z.string(),
  key_parties_or_entities: z.array(z.string()),
  dates_and_amounts: z.array(z.string()),
  action_needed: z.string().nullable(),
});

export type AttachmentSummary = z.infer<typeof AttachmentSummarySchema>;

export interface ClassificationDecision {
  messageId: string;
  threadId: string;
  subject: string;
  sender: string;
  chosenLabelName: string;
  chosenLabelId: string;
  confidence: number;
  reasoning: string;
  isActionRequired: boolean;
  isFallback: boolean;
  isArchived: boolean;
  isMarkedRead: boolean;
}

export interface UnmatchedEmailRecord {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  date: string;
  confidence: number;
  reasoning: string;
  unmatchedAt: string;
}

