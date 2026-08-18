import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LLMEngine, RuleManager, UnmatchedManager, upgradeLegacyRules } from './classifier.js';
import { getAuthenticatedClient, GmailClient, parseThread } from './gmail.js';
import { distillStyleFromSentEmails, generateSmartReply, PendingRepliesManager, StyleProfileManager } from './smartReply.js';
import { appendWebLog, startPersistentWebServer } from './webServer.js';
import type { AppConfig, ClassificationDecision, ClassificationResult, PartialAppConfig } from './types.js';

let isShuttingDown = false;

const log = {
  info: (msg: string, ...args: unknown[]) => {
    const formatted = `[INFO] ${new Date().toISOString()} - ${msg}${args.length ? ' ' + args.join(' ') : ''}`;
    process.stdout.write(`\x1b[36m[INFO]\x1b[0m ${new Date().toISOString()} - ${msg}${args.length ? ' ' + args.join(' ') : ''}\n`);
    appendWebLog(formatted);
  },
  warn: (msg: string, ...args: unknown[]) => {
    const formatted = `[WARN] ${new Date().toISOString()} - ${msg}${args.length ? ' ' + args.join(' ') : ''}`;
    process.stderr.write(`\x1b[33m[WARN]\x1b[0m ${new Date().toISOString()} - ${msg}${args.length ? ' ' + args.join(' ') : ''}\n`);
    appendWebLog(formatted);
  },
  error: (msg: string, ...args: unknown[]) => {
    const formatted = `[ERROR] ${new Date().toISOString()} - ${msg}${args.length ? ' ' + args.join(' ') : ''}`;
    process.stderr.write(`\x1b[31m[ERROR]\x1b[0m ${new Date().toISOString()} - ${msg}${args.length ? ' ' + args.join(' ') : ''}\n`);
    appendWebLog(formatted);
  },
  success: (msg: string, ...args: unknown[]) => {
    const formatted = `[SUCCESS] ${new Date().toISOString()} - ${msg}${args.length ? ' ' + args.join(' ') : ''}`;
    process.stdout.write(`\x1b[32;1m[SUCCESS]\x1b[0m ${new Date().toISOString()} - ${msg}${args.length ? ' ' + args.join(' ') : ''}\n`);
    appendWebLog(formatted);
  },
};

const updateHeartbeat = (status: 'healthy' | 'shutting_down' | 'idle', details?: Record<string, unknown>): void => {
  const heartbeatPath = process.env['HEARTBEAT_PATH'] ?? '/tmp/heartbeat.json';
  try {
    const payload = {
      timestamp: new Date().toISOString(),
      status,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      ...details,
    };
    writeFileSync(heartbeatPath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // Heartbeat write failure
  }
};

const registerSignalHandlers = (engineRef?: { current?: LLMEngine }): void => {
  const handleSignal = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.info(`Received ${signal}, commencing graceful shutdown...`);
    updateHeartbeat('shutting_down');

    if (engineRef?.current) {
      try {
        await engineRef.current.unloadModel();
      } catch {
        // Model unload during shutdown
      }
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err instanceof Error ? err.message : String(err)}`, err instanceof Error ? err.stack : undefined);
  });

  process.on('unhandledRejection', (reason) => {
    log.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
};

const parseEnvNumber = (key: string, fallback: number): number => {
  const val = process.env[key];
  if (!val) return fallback;
  const num = parseFloat(val);
  return Number.isNaN(num) ? fallback : num;
};

const parseEnvBoolean = (key: string, fallback: boolean): boolean => {
  const val = process.env[key];
  if (!val) return fallback;
  return val.toLowerCase() === 'true' || val === '1';
};

const parseEnvArray = (key: string, fallback: string[]): string[] => {
  const val = process.env[key];
  if (!val) return fallback;
  return val.split(',').map((item) => item.trim()).filter(Boolean);
};

export const resolveDataPath = (fileName: string, explicitPath?: string): string => {
  const targetName = explicitPath ?? fileName;
  if (isAbsolute(targetName)) {
    return targetName;
  }
  const dataSubpath = resolve(process.cwd(), 'data', targetName);
  if (existsSync(dataSubpath)) {
    return dataSubpath;
  }
  const rootPath = resolve(process.cwd(), targetName);
  if (existsSync(rootPath)) {
    return rootPath;
  }
  const dataDir = resolve(process.cwd(), 'data');
  if (existsSync(dataDir)) {
    return dataSubpath;
  }
  return rootPath;
};

const DEFAULT_CONFIG: AppConfig = {
  ollama: {
    host: process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434',
    model: process.env['OLLAMA_MODEL'] ?? 'phi4-mini',
    contextWindow: parseEnvNumber('OLLAMA_CONTEXT_WINDOW', 32768),
    temperature: parseEnvNumber('OLLAMA_TEMPERATURE', 0.0),
    keepAlive: process.env['OLLAMA_KEEP_ALIVE'] ?? '15s',
    remoteModel: process.env['OLLAMA_REMOTE'] ?? process.env['OLLAMA_REMOTE_MODEL'] ?? process.env['OLLAMA_CLOUD_MODEL'] ?? 'gemma4:31b-cloud',
    remoteHost: process.env['OLLAMA_REMOTE_HOST'],
    cloudModel: process.env['OLLAMA_REMOTE'] ?? process.env['OLLAMA_REMOTE_MODEL'] ?? process.env['OLLAMA_CLOUD_MODEL'] ?? 'gemma4:31b-cloud',
  },
  gmail: {
    credentialsPath: resolveDataPath('credentials.json', process.env['GMAIL_CREDENTIALS_PATH']),
    tokenPath: resolveDataPath('token.json', process.env['GMAIL_TOKEN_PATH']),
    searchQuery: process.env['GMAIL_SEARCH_QUERY'] ?? 'has:nouserlabels in:inbox',
    fallbackLabelName: process.env['GMAIL_FALLBACK_LABEL'] ?? 'Other',
    batchSize: parseEnvNumber('GMAIL_BATCH_SIZE', 10),
    oauthPort: parseEnvNumber('GMAIL_OAUTH_PORT', 3000),
    autoArchiveLabels: parseEnvArray('GMAIL_AUTO_ARCHIVE_LABELS', ['Advertisement']),
    autoMarkReadLabels: parseEnvArray(
      'GMAIL_AUTO_MARK_READ_LABELS',
      parseEnvBoolean('MARK_ADVERTS_AS_READ', true) || parseEnvBoolean('GMAIL_MARK_ADVERTS_AS_READ', true)
        ? ['Advertisement']
        : []
    ),
  },
  classification: {
    minConfidenceThreshold: parseEnvNumber('MIN_CONFIDENCE_THRESHOLD', 0.7),
    escalationThreshold: parseEnvNumber('ESCALATION_THRESHOLD', 0.95),
    learnedRulesPath: resolveDataPath('learned_rules.json', process.env['LEARNED_RULES_PATH']),
    unmatchedPath: resolveDataPath('unmatched.json', process.env['UNMATCHED_PATH']),
    historyPath: resolveDataPath('history.csv', process.env['HISTORY_PATH']),
    labelHints: {},
  },
  prompts: {
    classificationSystem: process.env['PROMPT_CLASSIFICATION_SYSTEM'],
    remoteEscalationSystem: process.env['PROMPT_REMOTE_ESCALATION_SYSTEM'] ?? process.env['PROMPT_CLOUD_ESCALATION_SYSTEM'],
    cloudEscalationSystem: process.env['PROMPT_REMOTE_ESCALATION_SYSTEM'] ?? process.env['PROMPT_CLOUD_ESCALATION_SYSTEM'],
    attachmentSummarySystem: process.env['PROMPT_ATTACHMENT_SUMMARY_SYSTEM'],
  },
};

export const loadConfig = (customPath?: string): AppConfig => {
  const configPath = customPath
    ? resolve(process.cwd(), customPath)
    : resolveDataPath('config.json');

  if (!existsSync(configPath)) return DEFAULT_CONFIG;

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as PartialAppConfig;
    const isMarkAdvertsEnabled =
      parseEnvBoolean('MARK_ADVERTS_AS_READ', false) ||
      parseEnvBoolean('GMAIL_MARK_ADVERTS_AS_READ', false);

    const remoteModelValue =
      process.env['OLLAMA_REMOTE'] ??
      process.env['OLLAMA_REMOTE_MODEL'] ??
      parsed.ollama?.remoteModel ??
      process.env['OLLAMA_CLOUD_MODEL'] ??
      parsed.ollama?.cloudModel ??
      DEFAULT_CONFIG.ollama.remoteModel;

    return {
      ollama: {
        ...DEFAULT_CONFIG.ollama,
        ...parsed.ollama,
        host: process.env['OLLAMA_HOST'] ?? parsed.ollama?.host ?? DEFAULT_CONFIG.ollama.host,
        model: process.env['OLLAMA_MODEL'] ?? parsed.ollama?.model ?? DEFAULT_CONFIG.ollama.model,
        remoteModel: remoteModelValue,
        remoteHost: process.env['OLLAMA_REMOTE_HOST'] ?? parsed.ollama?.remoteHost ?? DEFAULT_CONFIG.ollama.remoteHost,
        cloudModel: remoteModelValue,
        contextWindow: parseEnvNumber('OLLAMA_CONTEXT_WINDOW', parsed.ollama?.contextWindow ?? DEFAULT_CONFIG.ollama.contextWindow),
        temperature: parseEnvNumber('OLLAMA_TEMPERATURE', parsed.ollama?.temperature ?? DEFAULT_CONFIG.ollama.temperature),
        keepAlive: process.env['OLLAMA_KEEP_ALIVE'] ?? parsed.ollama?.keepAlive ?? DEFAULT_CONFIG.ollama.keepAlive,
      },
      gmail: {
        ...DEFAULT_CONFIG.gmail,
        ...parsed.gmail,
        credentialsPath: resolveDataPath('credentials.json', process.env['GMAIL_CREDENTIALS_PATH'] ?? parsed.gmail?.credentialsPath),
        tokenPath: resolveDataPath('token.json', process.env['GMAIL_TOKEN_PATH'] ?? parsed.gmail?.tokenPath),
        searchQuery: process.env['GMAIL_SEARCH_QUERY'] ?? parsed.gmail?.searchQuery ?? DEFAULT_CONFIG.gmail.searchQuery,
        fallbackLabelName: process.env['GMAIL_FALLBACK_LABEL'] ?? parsed.gmail?.fallbackLabelName ?? DEFAULT_CONFIG.gmail.fallbackLabelName,
        batchSize: parseEnvNumber('GMAIL_BATCH_SIZE', parsed.gmail?.batchSize ?? DEFAULT_CONFIG.gmail.batchSize),
        oauthPort: parseEnvNumber('GMAIL_OAUTH_PORT', parsed.gmail?.oauthPort ?? DEFAULT_CONFIG.gmail.oauthPort),
        autoArchiveLabels: parseEnvArray('GMAIL_AUTO_ARCHIVE_LABELS', parsed.gmail?.autoArchiveLabels ?? DEFAULT_CONFIG.gmail.autoArchiveLabels),
        autoMarkReadLabels: parseEnvArray(
          'GMAIL_AUTO_MARK_READ_LABELS',
          isMarkAdvertsEnabled
            ? ['Advertisement']
            : parsed.gmail?.autoMarkReadLabels ?? DEFAULT_CONFIG.gmail.autoMarkReadLabels
        ),
      },
      classification: {
        ...DEFAULT_CONFIG.classification,
        ...parsed.classification,
        minConfidenceThreshold: parseEnvNumber('MIN_CONFIDENCE_THRESHOLD', parsed.classification?.minConfidenceThreshold ?? DEFAULT_CONFIG.classification.minConfidenceThreshold),
        escalationThreshold: parseEnvNumber('ESCALATION_THRESHOLD', parsed.classification?.escalationThreshold ?? DEFAULT_CONFIG.classification.escalationThreshold),
        learnedRulesPath: resolveDataPath('learned_rules.json', process.env['LEARNED_RULES_PATH'] ?? parsed.classification?.learnedRulesPath),
        unmatchedPath: resolveDataPath('unmatched.json', process.env['UNMATCHED_PATH'] ?? parsed.classification?.unmatchedPath),
        historyPath: resolveDataPath('history.csv', process.env['HISTORY_PATH'] ?? parsed.classification?.historyPath),
      },
      prompts: {
        classificationSystem: process.env['PROMPT_CLASSIFICATION_SYSTEM'] ?? parsed.prompts?.classificationSystem,
        remoteEscalationSystem: process.env['PROMPT_REMOTE_ESCALATION_SYSTEM'] ?? parsed.prompts?.remoteEscalationSystem ?? process.env['PROMPT_CLOUD_ESCALATION_SYSTEM'] ?? parsed.prompts?.cloudEscalationSystem,
        cloudEscalationSystem: process.env['PROMPT_REMOTE_ESCALATION_SYSTEM'] ?? parsed.prompts?.remoteEscalationSystem ?? process.env['PROMPT_CLOUD_ESCALATION_SYSTEM'] ?? parsed.prompts?.cloudEscalationSystem,
        attachmentSummarySystem: process.env['PROMPT_ATTACHMENT_SUMMARY_SYSTEM'] ?? parsed.prompts?.attachmentSummarySystem,
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
};

export const runClassificationBatch = async (
  gmailClient: GmailClient,
  config: AppConfig,
  options: {
    dryRun?: boolean;
    trainingMode?: boolean;
    customQuery?: string;
    customLimit?: number;
    historyFile?: string;
  } = {}
): Promise<ClassificationDecision[]> => {
  const dryRun = options.dryRun ?? false;
  const trainingMode = options.trainingMode ?? false;
  const effectiveEscalationThreshold = trainingMode ? 1.0 : config.classification.escalationThreshold;
  const historyFilePath = options.historyFile ? resolve(process.cwd(), options.historyFile) : resolve(process.cwd(), config.classification.historyPath);

  const ruleManager = new RuleManager(config.classification.learnedRulesPath);
  const unmatchedManager = new UnmatchedManager(config.classification.unmatchedPath);
  const escalationModel = config.ollama.remoteModel ?? config.ollama.cloudModel;
  const llmEngine = new LLMEngine({
    host: config.ollama.host,
    model: config.ollama.model,
    remoteModel: escalationModel,
    remoteHost: config.ollama.remoteHost,
    contextWindow: config.ollama.contextWindow,
    temperature: config.ollama.temperature,
    keepAlive: config.ollama.keepAlive,
    labelHints: config.classification.labelHints,
    prompts: config.prompts,
  });

  registerSignalHandlers({ current: llmEngine });

  if (trainingMode) {
    log.info('Training mode active: escalating all confidence < 1.00 to remote model to distill rules.');
  }

  for (const hintLabelName of Object.keys(config.classification.labelHints)) {
    if (isShuttingDown) break;
    await gmailClient.getOrCreateLabel(hintLabelName);
  }

  const userLabels = await gmailClient.getUserLabels();
  const fallbackLabel = await gmailClient.getOrCreateLabel(config.gmail.fallbackLabelName);

  const combinedLabelsToSweep = Array.from(
    new Set([...config.gmail.autoArchiveLabels, ...config.gmail.autoMarkReadLabels])
  );

  if (combinedLabelsToSweep.length > 0 && !isShuttingDown) {
    for (const labelName of combinedLabelsToSweep) {
      if (isShuttingDown) break;
      try {
        const isArchive = config.gmail.autoArchiveLabels.some((l) => l.toLowerCase() === labelName.toLowerCase());
        const isMarkRead = config.gmail.autoMarkReadLabels.some((l) => l.toLowerCase() === labelName.toLowerCase());

        const queryParts: string[] = [];
        if (isArchive) queryParts.push('in:inbox');
        if (isMarkRead) queryParts.push('is:unread');
        const sweepQuery = `label:"${labelName}" (${queryParts.join(' OR ')})`;

        const existingIds = await gmailClient.listAllMessageIds(sweepQuery);
        if (existingIds.length > 0) {
          const removeLabelIds: string[] = [];
          if (isArchive) removeLabelIds.push('INBOX');
          if (isMarkRead) removeLabelIds.push('UNREAD');

          const actionList = [
            isArchive ? 'Archiving' : '',
            isMarkRead ? 'Marking as read' : '',
          ].filter(Boolean);

          log.info(`Found ${existingIds.length} legacy "${labelName}" email(s). ${actionList.join(' & ')} in batch...`);
          if (!dryRun) {
            await gmailClient.batchModifyLabels(existingIds, { removeLabelIds });
          }
          log.success(`Processed ${existingIds.length} legacy "${labelName}" email(s).`);
        }
      } catch (err) {
        log.warn(`Failed to sweep legacy "${labelName}" emails:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  const query = options.customQuery ?? config.gmail.searchQuery;
  const batchSize = options.customLimit ?? config.gmail.batchSize;

  const messageIds = isShuttingDown ? [] : await gmailClient.listUnlabeledMessageIds(query, batchSize);

  if (messageIds.length === 0) {
    log.info(`No emails found matching query: "${query}".`);
    await llmEngine.unloadModel();
    updateHeartbeat('healthy', { messagesProcessed: 0 });
    return [];
  }

  const styleProfilePath = resolveDataPath('learned_response.json', process.env['LEARNED_RESPONSE_PATH']);
  const styleProfileManager = new StyleProfileManager(styleProfilePath);
  const pendingRepliesPath = resolveDataPath('pending_replies.json', process.env['PENDING_REPLIES_PATH']);
  const pendingRepliesManager = new PendingRepliesManager(pendingRepliesPath);

  const mapConcurrent = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R | undefined>
): Promise<R[]> => {
  const results: (R | undefined)[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length && !isShuttingDown) {
      const currentIndex = nextIndex++;
      const item = items[currentIndex];
      if (item !== undefined) {
        results[currentIndex] = await fn(item, currentIndex);
      }
    }
  });
  await Promise.all(workers);
  return results.filter((r): r is R => r !== undefined);
};

  const learnedRules = ruleManager.getActiveRules();
  if (learnedRules.length > 0) {
    log.info(`Loaded ${learnedRules.length} learned disambiguation rule(s) into Tier 1 prompt.`);
  }

  const concurrency = parseEnvNumber('CONCURRENCY', 3);
  log.info(`Found ${messageIds.length} message(s) matching query: "${query}" (Concurrency: ${concurrency}).`);

  const decisions = await mapConcurrent(messageIds, concurrency, async (messageId, index) => {
    if (isShuttingDown) return undefined;

    try {
      const rawMessage = await gmailClient.getMessage(messageId);
      const threadId = rawMessage.threadId ?? messageId;
      const threadData = await gmailClient.getThread(threadId);

      const parsedThread = await parseThread(threadData, gmailClient, (filename, mimeType, rawText) => {
        log.info(`Extracting and summarizing PDF attachment "${filename}" (${rawText.length} chars)...`);
        return llmEngine.summarizeAttachment(filename, mimeType, rawText);
      });

      const latestMessage = parsedThread.messages[parsedThread.messages.length - 1];
      const subject = latestMessage?.subject ?? 'No Subject';
      const sender = latestMessage?.sender ?? 'Unknown Sender';

      const directRuleMatch = !trainingMode ? ruleManager.evaluate(sender, subject, latestMessage?.cleanBody) : undefined;
      let classification: ClassificationResult;

      if (directRuleMatch) {
        const patternDesc = directRuleMatch.rule.subjectPattern ? ` /${directRuleMatch.rule.subjectPattern}/` : '';
        log.info(`[${index + 1}/${messageIds.length}] [Tier 0 Algorithmic Match] "${sender}"${patternDesc} -> "${directRuleMatch.rule.targetLabel}"`);
        classification = {
          selected_label: directRuleMatch.rule.targetLabel,
          confidence: directRuleMatch.confidence,
          reasoning: directRuleMatch.rule.reasoning,
          is_action_required: false,
        };
      } else {
        const threadLength = parsedThread.fullConversationContext.length;
        const estTokens = Math.round(threadLength / 4);
        log.info(`[${index + 1}/${messageIds.length}] Analyzing "${parsedThread.subject}" (~${estTokens.toLocaleString()} tokens)...`);

        classification = await llmEngine.classifyThread(parsedThread, userLabels, learnedRules);

        if (
          classification.confidence < effectiveEscalationThreshold &&
          escalationModel
        ) {
          const tier1Notes = `Tier 1 model "${config.ollama.model}" classified as "${classification.selected_label}" with confidence ${classification.confidence.toFixed(2)}. Reasoning: ${classification.reasoning}`;

          log.info(
            `[Remote Escalation] Confidence (${classification.confidence.toFixed(2)}) < ${effectiveEscalationThreshold.toFixed(2)} for "${parsedThread.subject}". Escalating to Remote (${escalationModel})...`
          );

          try {
            const remoteResult = await llmEngine.classifyWithRemote(
              parsedThread,
              userLabels,
              tier1Notes
            );

            if (remoteResult.confidence >= classification.confidence) {
              classification = remoteResult;
              log.info(`[Remote Result] Decided: "${classification.selected_label}" (Confidence: ${classification.confidence.toFixed(2)})`);
            }

            if (remoteResult.learned_rule) {
              const validatedRule = ruleManager.validateAndAddRule(
                remoteResult.learned_rule,
                { sender, subject }
              );
              if (validatedRule) {
                const patternDesc = validatedRule.subjectPattern ? ` /${validatedRule.subjectPattern}/` : '';
                log.info(`[Algorithmic Rule Synthesized] "${validatedRule.senderDomain}"${patternDesc} → "${validatedRule.targetLabel}": ${validatedRule.reasoning}`);
              }
            }
          } catch (err) {
            log.warn(`Remote model (${escalationModel}) unavailable, keeping Tier 1 result:`, err instanceof Error ? err.message : String(err));
          }
        }
      }

      const isConfident =
        Boolean(classification.selected_label) &&
        classification.confidence >= config.classification.minConfidenceThreshold;

      const targetLabelName = isConfident && classification.selected_label
        ? classification.selected_label
        : fallbackLabel.name;

      const matchedLabel = userLabels.find((label) => label.name.toLowerCase() === targetLabelName.toLowerCase()) ?? fallbackLabel;

      const shouldArchive =
        isConfident &&
        config.gmail.autoArchiveLabels.some(
          (label) => label.toLowerCase() === matchedLabel.name.toLowerCase()
        );

      const shouldMarkRead =
        isConfident &&
        config.gmail.autoMarkReadLabels.some(
          (label) => label.toLowerCase() === matchedLabel.name.toLowerCase()
        );

      const decision: ClassificationDecision = {
        messageId,
        threadId,
        subject,
        sender,
        chosenLabelName: matchedLabel.name,
        chosenLabelId: matchedLabel.id,
        confidence: classification.confidence,
        reasoning: classification.reasoning,
        isActionRequired: classification.is_action_required,
        isFallback: !isConfident || matchedLabel.id === fallbackLabel.id,
        isArchived: shouldArchive,
        isMarkedRead: shouldMarkRead,
      };

      appendHistoryCsv(historyFilePath, decision);

      if (decision.isFallback) {
        const messageDate = latestMessage?.date ?? new Date().toISOString();
        unmatchedManager.addRecord({
          id: messageId,
          threadId,
          subject,
          sender,
          date: messageDate,
          confidence: decision.confidence,
          reasoning: decision.reasoning,
          unmatchedAt: new Date().toISOString(),
        });
        log.info(`[Unmatched] Recorded email ID "${messageId}" ("${subject}") to unmatched.json for category planning.`);
      }

      const actionNotes: string[] = [];
      if (shouldArchive) actionNotes.push('Archived from Inbox');
      if (shouldMarkRead) actionNotes.push('Marked as Read');
      const actionSuffix = actionNotes.length > 0 ? ` (${actionNotes.join(', ')})` : '';

      if (dryRun) {
        log.info(
          `[DRY-RUN] Message: "${subject}" from "${sender}" -> Label: "${decision.chosenLabelName}"${actionSuffix} (Confidence: ${decision.confidence})`
        );
      } else {
        const removeLabelIds: string[] = [];
        if (shouldArchive) removeLabelIds.push('INBOX');
        if (shouldMarkRead) removeLabelIds.push('UNREAD');
        await gmailClient.applyLabel(messageId, decision.chosenLabelId, removeLabelIds);
        log.success(
          `Applied label "${decision.chosenLabelName}"${actionSuffix} to "${subject}" (Confidence: ${decision.confidence})`
        );
      }

      if (
        decision.isActionRequired &&
        matchedLabel.name !== 'Advertisement' &&
        matchedLabel.name !== 'System'
      ) {
        try {
          const smartReplyModel = config.ollama.remoteModel ?? config.ollama.model;
          const replyGen = await generateSmartReply(
            parsedThread,
            styleProfileManager.getProfile(),
            config.ollama.host,
            smartReplyModel
          );
          if (replyGen.should_reply && replyGen.suggested_reply_text.trim().length > 0) {
            pendingRepliesManager.addPendingReply({
              threadId,
              messageId,
              sender,
              recipient: latestMessage?.recipient ?? '',
              subject,
              receivedAt: latestMessage?.date ?? new Date().toISOString(),
              originalSnippet: parsedThread.fullConversationContext.slice(0, 300),
              suggestedReply: replyGen.suggested_reply_text,
              confidence: replyGen.confidence,
              reasoning: replyGen.reasoning,
            });
            log.info(`[Smart Reply] Queued draft reply for "${subject}" (${replyGen.reasoning})`);
          }
        } catch (err) {
          log.warn(`Smart reply generation skipped for "${subject}":`, err instanceof Error ? err.message : String(err));
        }
      }

      return decision;
    } catch (err) {
      log.error(`Failed to process message ${messageId}:`, err instanceof Error ? err.message : String(err));
      return undefined;
    }
  });

  await llmEngine.unloadModel();
  log.info('Memory culled: Ollama model unloaded from RAM.');

  if (existsSync(historyFilePath)) {
    try {
      writeFileSync(historyFilePath, '', 'utf-8');
      log.info('Batch complete: history.csv wiped.');
    } catch {
      // Failed to wipe history
    }
  }

  updateHeartbeat('healthy', { messagesProcessed: decisions.length });
  return decisions;
};

const appendHistoryCsv = (filePath: string, decision: ClassificationDecision): void => {
  try {
    if (!existsSync(filePath) || statSync(filePath).size === 0) {
      writeFileSync(filePath, 'timestamp,message_id,label,confidence,archived,marked_read,subject,sender\n', 'utf-8');
    }
    const cleanSubject = `"${decision.subject.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    const cleanSender = `"${decision.sender.replace(/"/g, '""')}"`;
    const row = `${new Date().toISOString()},${decision.messageId},${decision.chosenLabelName},${decision.confidence.toFixed(2)},${decision.isArchived},${decision.isMarkedRead},${cleanSubject},${cleanSender}\n`;
    appendFileSync(filePath, row, 'utf-8');
  } catch {
    // Failed to write history CSV
  }
};

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
    query: { type: 'string', short: 'q' },
    limit: { type: 'string', short: 'l' },
    'dry-run': { type: 'boolean' },
    train: { type: 'boolean', short: 't' },
    once: { type: 'boolean' },
    server: { type: 'boolean', short: 's' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`Usage: local-ai-email-classifier [options]

Options:
  -c, --config <path>     Path to custom config.json
  -q, --query <string>    Custom Gmail search query
  -l, --limit <number>    Maximum number of messages to process
  -t, --train             Run in training mode (escalates any confidence < 1.0 to remote model to distill rules)
  --dry-run               Simulate classification without modifying Gmail labels
  --once                  Run a single classification pass and exit
  -s, --server            Run persistent Web UI dashboard only
  -h, --help              Show help information
`);
  process.exit(0);
}

const main = async (): Promise<void> => {
  registerSignalHandlers();
  updateHeartbeat('healthy', { status: 'starting' });
  const config = loadConfig(values.config);
  const limit = values.limit ? parseInt(values.limit, 10) : undefined;
  const isDryRun = Boolean(values['dry-run']);
  const isTraining = Boolean(values.train);
  const isServerOnly = Boolean(values.server);

  if (isServerOnly) {
    log.info(`Starting persistent Web UI dashboard on port ${config.gmail.oauthPort ?? 3000}...`);
    startPersistentWebServer({
      config,
      port: config.gmail.oauthPort ?? 3000,
      onTriggerRun: async () => {
        log.info('Manual classification run triggered from Web UI.');
        const freshConfig = loadConfig(values.config);
        const auth = await getAuthenticatedClient(freshConfig.gmail.credentialsPath, freshConfig.gmail.tokenPath, freshConfig.gmail.oauthPort);
        const gc = new GmailClient(auth);
        await runClassificationBatch(gc, freshConfig, { dryRun: false, trainingMode: false });
      },
      onTriggerTrain: async () => {
        log.info('Manual training pass triggered from Web UI (forcing Tier 2 rule synthesis)...');
        const freshConfig = loadConfig(values.config);
        const auth = await getAuthenticatedClient(freshConfig.gmail.credentialsPath, freshConfig.gmail.tokenPath, freshConfig.gmail.oauthPort);
        const gc = new GmailClient(auth);
        await runClassificationBatch(gc, freshConfig, { dryRun: false, trainingMode: true });
      },
      onUpgradeRules: async () => {
        log.info('Starting manual rule augmentation with Big Model (gemma4:31b-cloud)...');
        const freshConfig = loadConfig(values.config);
        const rm = new RuleManager(freshConfig.classification.learnedRulesPath);
        const upgradeModel = freshConfig.ollama.remoteModel ?? freshConfig.ollama.model;
        const result = await upgradeLegacyRules(rm, freshConfig.ollama.host, upgradeModel, (msg) => {
          log.info(`[Rule Upgrader] ${msg}`);
        });
        log.success(`Rule upgrade complete! ${result.upgradedCount} rule(s) augmented with deterministic regex.`);
        return result;
      },
      onCullMemory: async () => {
        const llm = new LLMEngine({
          host: config.ollama.host,
          model: config.ollama.model,
          contextWindow: config.ollama.contextWindow,
          temperature: config.ollama.temperature,
          keepAlive: 0,
          labelHints: config.classification.labelHints,
        });
        await llm.unloadModel();
        log.info('Memory culled: Ollama model unloaded from RAM.');
      },
      onLearnStyle: async () => {
        log.info('Learning personal writing style from recent sent emails...');
        const freshConfig = loadConfig(values.config);
        const auth = await getAuthenticatedClient(freshConfig.gmail.credentialsPath, freshConfig.gmail.tokenPath, freshConfig.gmail.oauthPort);
        const gc = new GmailClient(auth);
        const styleModel = freshConfig.ollama.remoteModel ?? freshConfig.ollama.model;
        const profile = await distillStyleFromSentEmails(gc, freshConfig.ollama.host, styleModel, 50);
        const styleManager = new StyleProfileManager(resolveDataPath('learned_response.json', process.env['LEARNED_RESPONSE_PATH']));
        styleManager.saveProfile(profile);
        log.success(`Style learning complete! Tone: "${profile.tone}". Saved to learned_response.json.`);
        return profile;
      },
      onSaveDraft: async (opts) => {
        log.info(`Saving smart reply draft in Gmail for "${opts.id}"...`);
        const freshConfig = loadConfig(values.config);
        const auth = await getAuthenticatedClient(freshConfig.gmail.credentialsPath, freshConfig.gmail.tokenPath, freshConfig.gmail.oauthPort);
        const gc = new GmailClient(auth);
        const pendingManager = new PendingRepliesManager(resolveDataPath('pending_replies.json', process.env['PENDING_REPLIES_PATH']));
        const item = pendingManager.getAllReplies().find((r) => r.id === opts.id || r.messageId === opts.id);
        if (!item) {
          throw new Error('Smart reply record not found');
        }
        await gc.createDraftReply({
          threadId: item.threadId,
          to: item.sender,
          subject: item.subject,
          body: opts.body,
        });
        pendingManager.markAsDrafted(item.id);
        log.success(`Successfully saved draft reply to "${item.subject}" in your Gmail Drafts folder.`);
      },
    });
    return;
  }

  log.info('Initializing Gmail authentication...');
  const auth = await getAuthenticatedClient(config.gmail.credentialsPath, config.gmail.tokenPath, config.gmail.oauthPort);
  const gmailClient = new GmailClient(auth);

  log.info(`Running classification pass (Dry-Run: ${isDryRun}, Training: ${isTraining})...`);
  await runClassificationBatch(gmailClient, config, {
    dryRun: isDryRun,
    trainingMode: isTraining,
    customQuery: values.query,
    customLimit: limit,
  });
  updateHeartbeat('healthy', { status: 'completed' });
  log.success('Classification pass completed.');
};

main().catch((err: unknown) => {
  log.error('Fatal application error:', err);
  process.exit(1);
});
