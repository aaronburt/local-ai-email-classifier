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
      learned_rule: z.object({
        sender_domain: z.string(),
        topic_condition: z.string(),
        target_label: z.string(),
        reasoning: z.string(),
      }).optional(),
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

export interface ConversationMessageNode {
  messageId: string;
  sender: string;
  recipient: string;
  date: string;
  snippet: string;
  bodyText: string;
  isFromUser: boolean;
}

export type ConversationThreadStatus = 'waiting_on_me' | 'waiting_on_other' | 'resolved';

export interface ActiveConversationThread {
  threadId: string;
  subject: string;
  otherParty: string;
  otherPartyEmail: string;
  status: ConversationThreadStatus;
  lastMessageDate: string;
  messageCount: number;
  threadSummary: string;
  nextActionNeeded?: string;
  messages: ConversationMessageNode[];
  updatedAt: string;
}

export const ThreadResolutionAnalysisSchema = z.object({
  status: z.enum(['waiting_on_me', 'waiting_on_other', 'resolved']).describe('Current resolution status of the thread'),
  other_party_name: z.string().describe('The name or organization of the external party'),
  other_party_email: z.string().describe('The email address of the external party'),
  thread_summary: z.string().describe('A concise 1-sentence executive summary of the conversation history'),
  next_action_needed: z.string().nullable().describe('Specific next action required or null if resolved'),
  confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1'),
});

export type ThreadResolutionAnalysis = z.infer<typeof ThreadResolutionAnalysisSchema>;
