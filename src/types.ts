import { z } from 'zod';

export interface AppConfig {
  ollama: {
    host: string;
    model: string;
    contextWindow: number;
    temperature: number;
    keepAlive: string | number;
    remoteModel?: string;
    remoteHost?: string;
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
    remoteEscalationSystem?: string;
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
  senderRegex?: string;
  subjectPattern?: string;
  excludePattern?: string;
  topicCondition?: string;
  targetLabel: string;
  reasoning: string;
  createdAt: string;
  hitCount?: number;
  lastMatchedAt?: string;
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

export const SynthesizedAlgorithmicRuleSchema = z.object({
  sender_domain: z.string().describe('Clean domain of the sender without protocol or subaddress (e.g. "amazon.co.uk", "stripe.com", "github.com")'),
  sender_regex: z.string().nullable().optional().describe('Optional regex matching sender local-part/subaddress (e.g. "^(auto-confirm|receipts)@")'),
  subject_pattern: z.string().describe('Invariant regex pattern matching the subject template with variables wildcarded (e.g. "^(?:Your order of|Order Confirmation)\\\\b.*")'),
  exclude_pattern: z.string().nullable().optional().describe('Optional negative regex to disqualify marketing/promos (e.g. "(?:deal|newsletter|discount)")'),
  target_label: z.string().describe('The target label name to assign'),
  reasoning: z.string().describe('Explanation of why this structural invariant pattern accurately classifies emails into the target label'),
});

export type SynthesizedAlgorithmicRule = z.infer<typeof SynthesizedAlgorithmicRuleSchema>;

export const createClassificationSchema = (allowedLabels: readonly string[], options?: { withRule?: boolean }) => {
  const confidenceSchema = z.number().transform((val) => (val > 1 ? Math.min(val / 100, 1.0) : Math.max(0, Math.min(val, 1.0))));
  const firstLabel = allowedLabels[0];
  const labelSchema = firstLabel
    ? z.enum([firstLabel, ...allowedLabels.slice(1)] as [string, ...string[]]).nullable()
    : z.string().nullable();

  const baseSchema = {
    selected_label: labelSchema,
    confidence: confidenceSchema,
    reasoning: z.string(),
    is_action_required: z.boolean(),
  };

  if (options?.withRule) {
    return z.object({
      ...baseSchema,
      learned_rule: SynthesizedAlgorithmicRuleSchema.optional(),
    });
  }

  return z.object(baseSchema);
};

export const createRemoteClassificationSchema = (allowedLabels: readonly string[]) =>
  createClassificationSchema(allowedLabels, { withRule: true });

export interface ClassificationResult {
  selected_label: string | null;
  confidence: number;
  reasoning: string;
  is_action_required: boolean;
}

export interface RemoteClassificationResult extends ClassificationResult {
  learned_rule?: SynthesizedAlgorithmicRule;
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

export const StyleProfileSchema = z.object({
  tone: z.string(),
  defaultGreetings: z.array(z.string()),
  defaultSignoffs: z.array(z.string()),
  averageLengthWords: z.number(),
  styleGuidelines: z.array(z.string()),
  learnedTemplates: z.array(
    z.object({
      trigger: z.string(),
      responseOutline: z.string(),
    })
  ),
  updatedAt: z.string(),
});

export type LearnedStyleProfile = z.infer<typeof StyleProfileSchema>;

export const SmartReplyGenerationSchema = z.object({
  should_reply: z.boolean(),
  reasoning: z.string(),
  suggested_reply_text: z.string(),
  confidence: z.number().min(0).max(1),
});

export type SmartReplyGeneration = z.infer<typeof SmartReplyGenerationSchema>;

export interface PendingSmartReply {
  id: string;
  threadId: string;
  messageId: string;
  sender: string;
  recipient: string;
  subject: string;
  receivedAt: string;
  originalSnippet: string;
  suggestedReply: string;
  confidence: number;
  reasoning: string;
  createdAt: string;
  status: 'pending' | 'drafted' | 'dismissed';
}
