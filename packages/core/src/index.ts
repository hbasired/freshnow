export { loadConfig, configSchema } from "./config.js";
export type { Config } from "./config.js";

export { PROJECT_NAME, IS_DEMO, DEMO_CEO_ID } from "./meta.js";

export { resolveRole, botRole } from "./roles.js";
export type { Role } from "./roles.js";

export { getAppSql, getServiceSql, withContext, closeDb } from "./db.js";
export type { Db, Tx, AppContext, AccessRole } from "./db.js";

export { ACCESS_ROLES, loadViewer, canAssignTo, updateOrg, OrgChangeRefused, ceoEmployeeId, listAssignable, listOpenBlockersFor } from "./org.js";
export {
  CAPABILITIES,
  CAPABILITY_MEANING,
  ROLE_CAPABILITIES,
  ROLE_INFO,
  can,
  capabilitiesOf,
  grantableRoles,
  isAccessRole,
  mayGiveWork,
  mayLeadPeople,
  maySeeOthersBlockers,
  roleChangeRefusal,
} from "./permissions.js";
export type { Actor, Capability, RoleInfo } from "./permissions.js";
export {
  addTaskStep,
  setStepDone,
  recomputeProgress,
  reportProgress,
  updateTaskFields,
  linkTasks,
  resolveBlocker,
  closeTask,
  INVERSE,
  MAX_RELATIONS_PER_TASK,
  PROGRESS_BANDS,
  PROGRESS_BAND_WIDTH,
  bandMidpoint,
  statedPercent,
} from "./progress.js";
export type { ProgressBand, ProgressSource, RelationKind, TaskStep } from "./progress.js";
export {
  checkPolicyAtStartup,
  evaluatePolicy,
  isProduction,
  isQuickTunnel,
  readRegistry,
  registry,
  registryPath,
  DETECTORS,
} from "./compliance.js";
export type { Finding, PolicyReport, Registry, RegistryService } from "./compliance.js";
export { complianceEvidence, exportPersonData, recordComplianceSnapshot } from "./compliance-evidence.js";
export type { ComplianceEvidence } from "./compliance-evidence.js";
export { redactIdentifiers } from "./llm/redact.js";
export type { ViewerOrg } from "./org.js";

export { logAudit } from "./audit.js";
export type { AuditEntry } from "./audit.js";

export { createInvite, generateInviteCode } from "./invite.js";
export type { CreatedInvite } from "./invite.js";

export { enqueueNotification } from "./outbox.js";
export type { OutboxMessage, OutboxChannel } from "./outbox.js";
export { OUTBOX_CHANNELS } from "./outbox.js";

export { extractBlocker, parseTaskUpdate, blockerExtractionSchema } from "./parse.js";
export type { BlockerExtraction, ParseResult } from "./parse.js";

export {
  routeBlocker,
  routeAndAlert,
  escalateBlocker,
  acknowledgeBlocker,
  slaSweep,
  sweepUnroutedBlockers,
  slaMinutesFor,
  loadSlaMinutes,
  resolveForCategory,
} from "./routing.js";
export type { RouteResult, RouteAndAlertResult, EscalationResult, UnroutedSweepResult } from "./routing.js";

export { recordTrace, traceStats, resetTraceStats, TRACE_STEPS } from "./trace.js";
export {
  CHANNELS,
  channelAvailability,
  channelStates,
  liveChannels,
  isChannelLive,
  setChannelEnabled,
  DELIVERY_MODES,
  deliveryModeOf,
  setDeliveryMode,
  DeliveryModeError,
} from "./channels.js";
export type { Channel, ChannelState, DeliveryMode } from "./channels.js";
export {
  savePushSubscription,
  deletePushSubscription,
  pushSubscriptionsFor,
  listMyDevices,
  markPushDelivered,
  hasPushDevice,
} from "./push.js";
export type { PushSubscriptionInput, StoredPushSubscription } from "./push.js";
export { screenInboundEmail, recordInboundEmail, secretMatches, addressOf } from "./inbound-email.js";
export type { InboundEmail, InboundVerdict } from "./inbound-email.js";
export { retentionSweep, retentionDays, eraseEmployee } from "./retention.js";
export type { RetentionResult, ErasureResult } from "./retention.js";
export type { TraceStep } from "./trace.js";

export { subscribeToChanges, changeSubscriberCount, closeChangeStream, orgChangeCount } from "./changes.js";
export type { ChangeEvent, ChangeListener, ChangeScope } from "./changes.js";
export { openLiveAudience, liveAudienceCount, liveAudienceStats, type LiveAudience } from "./live-audience.js";
export { salesByHour, OpsAccessRefused, OpsDayRefused, type HourlySales } from "./ops-sales.js";
export {
  SYSTEM_ACTOR_ID,
  UNCLASSIFIED,
  alarmDecision,
  alarmsNow,
  loadAlarmRules,
  syncMachineAlarms,
  OpsRefused,
  type AlarmRule,
  type AlarmSyncResult,
  type AlarmsNow,
  type NeedsAction,
} from "./ops-alarms.js";
export { sendMorningReport, type MorningResult } from "./ops-morning.js";
export {
  fleetNow,
  machineDetail,
  dayReport,
  type FleetNow,
  type FleetMachine,
  type MachineState,
  type MachineDetail,
  type CashCollection,
  type DayReport,
  type DayReportMachine,
} from "./ops-fleet.js";
export { machinePage, type MachinePage, type MachinePlace } from "./ops-machine-page.js";
export { refillsOn, salesList, type RefillRow, type SaleRow, type SalesList } from "./ops-activity.js";
export {
  PLACE,
  USE_REASONS,
  DAMAGE_REASONS,
  REFUSE_REASONS,
  REVERSE_REASONS,
  WRITE_OFF_REASONS,
  InventoryRefused,
  receiveDelivery,
  startHandover,
  answerHandover,
  cancelHandover,
  settleHandover,
  recordUse,
  reverseDocument,
  mayConfirm,
  type LineIn,
  type Posted,
  type Side,
} from "./inventory-ledger.js";
export {
  COUNT_KINDS,
  COUNT_DECISION_REASONS,
  startCount,
  submitCount,
  startRecount,
  submitRecount,
  waiveRecount,
  decideCount,
  cancelCount,
  type CountKind,
  type CountItem,
  type CountOutcome,
} from "./inventory-counts.js";
export {
  abilitiesOf,
  inventoryHome,
  inventoryDoc,
  inventoryHolders,
  inventoryMovements,
  inventoryDay,
  inventoryCount,
  inventoryCounts,
  type InventoryHome,
  type InventoryAbilities,
  type ItemNow,
  type DocCard,
  type CountCard,
  type CountDetail,
  type Holder,
  type InventoryDay,
  type MovementsQuery,
} from "./inventory-read.js";
export { ITEM_CATEGORIES, inventoryCatalogue, saveItem, type CatalogueItem, type ItemIn, type ItemCategory } from "./inventory-catalogue.js";
export {
  RETURN_REASONS,
  SHORT_WEIGHT_SHARE,
  cancelOrder,
  createOrder,
  listOrders,
  listSuppliers,
  orderDetail,
  isLight,
  noteGramsFor,
  parseKg,
  saveSupplier,
  setOrderReady,
  startReturn,
  updateOrder,
  validateOrder,
  type CreateOrder,
  type OrderCard,
  type OrderKind,
  type OrderLine,
  type OrderLineIn,
  type OrderRef,
  type OrderState,
  type OrdersQuery,
  type ReturnReason,
  type ShortLine,
  type Supplier,
  type SupplierIn,
  type UpdateOrder,
  type ValidateOrder,
  type Validated,
} from "./warehouse.js";
export {
  CSV_MAX_ROWS,
  itemTracking,
  listReorderRules,
  moveReport,
  moveReportCsv,
  reorderSuggestions,
  saveReorderRule,
  stockAt,
  supplierReport,
  type ItemTracking,
  type MoveRow,
  type MovesQuery,
  type MovesReport,
  type ReorderRule,
  type ReorderRuleIn,
  type StockAt,
  type Suggestion,
  type SupplierRow,
} from "./warehouse-reports.js";
export { inventoryReminders, stockList } from "./inventory-notify.js";
export {
  AED_NOTES,
  CASH_ACCOUNT,
  CASH_PHOTO_NEEDED,
  CASH_REVERSE_REASONS,
  CashRefused,
  aed,
  answerQuery,
  auditShift,
  cashAbilitiesOf,
  cashHome,
  cashMachines,
  cashShift,
  cashShifts,
  endShift,
  recordCollection,
  recordDeposit,
  recordExpense,
  recordTestVend,
  reverseCash,
  startShift,
  type CashAbilities,
  type CashEntry,
  type CashHome,
  type CashMachine,
  type CashPosted,
  type CashReverseReason,
  type ShiftDetail,
  type ShiftSummary,
} from "./cash.js";
export {
  EVIDENCE_KINDS,
  EVIDENCE_WORDS,
  RouteRefused,
  SHIFT_WINDOWS,
  STOP_TASKS,
  TASK_WORDS,
  cancelPlan,
  copyPlans,
  evidenceGrid,
  myRound,
  planById,
  plansOn,
  routeMachines,
  routePeople,
  savePlan,
  setMachineServiceRule,
  type EvidenceKind,
  type GridRow,
  type PlanCard,
  type PlanIn,
  type PlanStop,
  type ShiftWindow,
  type StopIn,
  type StopTask,
  type StopVisit,
} from "./routes.js";
export {
  addEvidence,
  endVisit,
  machineByToken,
  openVisitOf,
  recordVisitCash,
  recordVisitFill,
  removeEvidence,
  setTasksDone,
  startVisit,
  visitDetail,
  type VisitDetail,
  type VisitStarted,
} from "./visits.js";
export {
  AnalyticsRefused,
  BELOW_RATIO,
  MAX_CATEGORIES,
  MAX_RANGE_DAYS,
  NOT_COUNTED,
  TOP_RATIO,
  categoryChoices,
  checkCategories,
  checkRange,
  insightsOf,
  machineDaily,
  machinePerformance,
  setMachineCategory,
  type CategoryPerf,
  type Insight,
  type MachineDaily,
  type MachinePerf,
  type Performance,
  type Tier,
} from "./analytics.js";
export {
  PAYMENT_KINDS,
  compareInsights,
  compareSales,
  profileInsights,
  salesProfile,
  type CompareRequest,
  type CompareRow,
  type PaymentKind,
  type ProfileDay,
  type ProfileScope,
  type ProfileTotals,
  type SalesComparison,
  type SalesProfile,
} from "./analytics-explore.js";
export {
  PAYMENT,
  STORE_DAYS_PER_RUN,
  analyticsStoreHealth,
  backfillDayTotals,
  buildSalesDay,
  daysToBuild,
  runAnalyticsStore,
  type DayTotalsSource,
  type StoreBuild,
  type StoreHealth,
} from "./analytics-store.js";
export {
  DEVICE_AUTH,
  DeviceAuthRefused,
  appSessionFor,
  bindCredential,
  changePin,
  companySessionEnd,
  createEnrolment,
  devicePeople,
  enrolDevice,
  isAppAccessToken,
  issueSetupCode,
  listDevices,
  pinRefusal,
  pruneAppAuth,
  refreshSession,
  revokeCredential,
  revokeDevice,
  shortName,
  signIn,
  signOut,
  type AppTokens,
  type DeviceSummary,
  type EnrolledDevice,
} from "./device-auth.js";

export {
  PROJECT_STATUSES,
  HEALTHS,
  REQUIREMENT_KINDS,
  MOSCOW,
  ISSUE_KINDS,
  ISSUE_STATUSES,
  MEMBER_ROLES,
  STALE_PROJECT_DAYS,
  createProject,
  updateProject,
  setProjectHealth,
  addRequirement,
  setRequirementStatus,
  addMilestone,
  setMilestoneStatus,
  addProjectMember,
  removeProjectMember,
  setTaskProject,
  addProjectUpdate,
  raiseProjectIssue,
  resolveProjectIssue,
  projectSweep,
  canManageProject,
  canContributeToProject,
} from "./projects.js";
export type {
  ProjectStatus,
  Health,
  RequirementKind,
  Moscow,
  IssueKind,
  IssueStatus,
  MemberRole,
  ProjectSweepResult,
} from "./projects.js";

export {
  ALERT_EVENT_TYPES,
  PREF_EVENT_TYPES,
  PREF_MODES,
  availableChannels,
  resolveAlertRecipients,
  notify,
  notifyPeople,
  presentationOf,
  openAlert,
  blockerAlias,
  loadEscalationLadder,
  mayAcknowledgeBlocker,
  addTaskWatcher,
  removeTaskWatcher,
  setNotificationPref,
  markNotificationsRead,
  NOTIFY_CHOICES,
  reachOf,
} from "./alerts.js";
export type { AlertEvent, AlertEventType, PrefEventType, AlertRecipient, NotifyResult, EscalationLevelRow, PrefMode, Presentation, NotifyChoice, PersonReach, ChoiceReach } from "./alerts.js";

export { replayRun } from "./replay.js";
export type { ReplayReport, ReplayCheck } from "./replay.js";

export { seedDemo } from "./seed.js";
export type { SeedCounts } from "./seed.js";

export { answerQuestion, MAX_ROWS } from "./query/answer.js";
export type { QueryResult } from "./query/answer.js";
export { validateReadOnlySql } from "./query/guard.js";
export { numericSanityGate } from "./query/gates.js";

export { llmComplete, LlmError, LlmBudgetExceededError } from "./llm/client.js";
export {
  isTracingEnabled,
  langfuseConfig,
  traceLlmCall,
  flushTraces,
  tracingStats,
  stopTracing,
  resetTracingStats,
} from "./llm/langfuse.js";
export type { LangfuseConfig, TracedCall } from "./llm/langfuse.js";
export type { LlmMessage, LlmCompleteOpts } from "./llm/client.js";
export { extractJson } from "./llm/extract.js";
export { estimateCost } from "./llm/cost.js";

export {
  validateInvite,
  redeemInvite,
  PROFILE_STEPS,
  SELF_FILL_ONCE,
  profilePrompt,
  profileStepsFor,
  updateProfileField,
  ensureCeoLinked,
  withdrawConsent,
  CeoWithdrawalRefused,
} from "./onboarding.js";
export type { InviteCheck, RedeemResult, ProfileStep, ProfileField } from "./onboarding.js";

export {
  CONSENT_POLICY_VERSION,
  consentNotice,
  dataRecipientLines,
  noticeHash,
  currentNoticeHash,
  currentNoticeHashes,
  noticeTag,
  hasCurrentConsent,
  consentStatus,
  recordConsent,
  consentKeyboard,
  requestConsentFromEveryone,
  ConsentNoticeChangedError,
  televendReachable,
  phoneAppOn,
} from "./consent.js";
export type { ConsentStatus } from "./consent.js";
export { TELEGRAM_TEXT_LIMIT, telegramParts } from "./telegram-text.js";

export {
  listOpenTasks,
  createTask,
  recordTaskUpdate,
  attachNoteAndProcess,
  listEmployees,
  listOpenBlockers,
  assignTask,
  NoReachableChannelError,
  TaskNotYoursError,
} from "./updates.js";
export type {
  OpenTask,
  ReportedStatus,
  UpdateChannel,
  RecordedUpdate,
  ProcessedNote,
  DirectoryEntry,
  OpenBlocker,
  AssignmentResult,
  AssignmentOrigin,
} from "./updates.js";

export {
  transcribeAudio,
  saveVoiceAsset,
  markVoiceTranscribed,
  markVoiceFailed,
} from "./voice.js";
export type { Transcription } from "./voice.js";

export { classifyIntent, intentSchema, isObviousQuestion, summariseOwnWork, formatOwnWork } from "./intent.js";
export type { Intent, OwnWorkSummary } from "./intent.js";

export { loadMessageContext, resolveMessage, groundResolution } from "./context.js";
export { checkNamedPerson, matchPeopleByName, nameWords } from "./people-match.js";
export type { NamedPerson, PersonCheck } from "./people-match.js";
export type { MessageContext, ResolvedMessage, ResolvedItem, ContextTask, ContextPerson } from "./context.js";

export { generateEodReport, generateAllEodReports, formatEodReport } from "./eod.js";
export type { EodReport, EodTaskLine, EodBlockerLine } from "./eod.js";

export { saveAttachments, gateIncomingDocument, listAttachmentsForAssignment, describeAttachment, MAX_ATTACHMENTS } from "./attachments.js";
export type { GateResult, IncomingFile, StoredAttachment } from "./attachments.js";

export {
  extractPdfText,
  decodeTextFile,
  planDocumentTasks,
  groundDocumentTasks,
  planningDirectory,
  formatDocumentPlan,
  MAX_DOC_CHARS,
  MAX_DOC_TASKS,
} from "./documents.js";
export type { ExtractedDocument, DocumentTask, DocumentPlan } from "./documents.js";

export {
  inspectFile,
  detectFileType,
  safeFileName,
  explainVerdict,
  MAX_FILE_BYTES,
  MAX_PDF_PAGES,
  MAX_TEXT_CHARS,
} from "./document-security.js";
export type { SafetyReport, Verdict } from "./document-security.js";
export { antivirusConfig, antivirusStatus, scanBytes } from "./antivirus.js";
export type { AntivirusConfig, ScanResult } from "./antivirus.js";
export { extractPdfTextSandboxed, PdfSandboxError, PDF_SANDBOX } from "./pdf-sandbox.js";

export {
  scanForInjection,
  spotlight,
  sanitiseModelText,
  outputLooksInjected,
  logInjectionScan,
  explainInjection,
  SPOTLIGHT_RULE,
} from "./injection.js";
export type { InjectionScan } from "./injection.js";

export { checkRateLimit, LIMITS } from "./rate-limit.js";
export type { RateLimit, RateDecision } from "./rate-limit.js";

export { localTime, localDateTime, localDate, companyToday, COMPANY_TZ } from "./time.js";

export { Semaphore, QueueFullError, llmSemaphore, documentSemaphore, concurrencyStats } from "./concurrency.js";
export type { SemaphoreStats } from "./concurrency.js";
export { escapeMarkdown } from "./document-security.js";

// Email in and out (TASK-053).
export { emailAllowlist, emailAddressAllowed, emailStatus, inboxConfig, replyToAddress } from "./email-config.js";
export type { InboxConfig } from "./email-config.js";
export {
  authPasses,
  emailAddressOf,
  extractReply,
  formatTaskKey,
  normaliseMessageId,
  parseEmailStatus,
  parseReferences,
  readAuthResults,
  taskNumberFromSubject,
  TASK_KEY_PREFIX,
} from "./email-reply.js";
export { composeOutboundEmail, recordOutboundEmail } from "./email-outbound.js";
export type { EmailPayload, OutboundEmail } from "./email-outbound.js";
export {
  processInboundEmail,
  screenAndRoute,
  listPendingEmailProposals,
  pendingEmailProposal,
  recordWebhookProposal,
  decideEmailProposal,
  unreadInboundEmails,
  storedInboundMessage,
  MAX_EMAIL_ATTEMPTS,
  isConsentAgreement,
} from "./email-inbound.js";
export type { InboundEmailMessage, InboundEmailOutcome, EmailProposalRow } from "./email-inbound.js";
export { relevantPeople, CONTEXT_LIMITS } from "./context-scope.js";
export type { ScopedPeople } from "./context-scope.js";
export { setEmployeeEmail, emailOverview, emailHealth, EmailAddressError, EmailChangeRefused, checkedEmployeeEmail } from "./email-people.js";
export { addPerson, AddPersonError } from "./people.js";
export type { AddPersonInput, AddPersonResult } from "./people.js";
export type { EmailOverview } from "./email-people.js";

export {
  syncMachines,
  syncVendsWindow,
  syncEventsWindow,
  syncRefillsDay,
  runIncrementalSync,
  checkDay,
  backfillDays,
  describeDayCheck,
  televendHealth,
  remapUnknownRefills,
  refillDays,
  dubaiDate,
  isWholeDubaiDays,
  TelevendSyncError,
  DAY_STREAMS,
  DAILY_CHECK_HOUR,
  DAILY_CHECK_MAX_ATTEMPTS,
  MAX_REFILL_DAYS,
} from "./televend-sync.js";
export type {
  SyncContext,
  SyncResult,
  WindowResult,
  MachinesResult,
  RefillRead,
  DayCheck,
  DayStream,
  TelevendHealth,
} from "./televend-sync.js";

export {
  storeMedia,
  readMedia,
  linkMediaToTask,
  mediaRetentionSweep,
  forgetMediaOf,
  mediaRetentionDays,
  MEDIA_RETENTION_DEFAULT_DAYS,
  RETENTION_CLASSES,
} from "./media.js";
export type { StoredMedia, RetentionClass } from "./media.js";
export { MediaError, MEDIA_LIMITS, sniff, cleanPhoto, cleanMp4 } from "./media-process.js";
export { mediaStore, useMediaStoreForTests, MemoryMediaStore, SupabaseMediaStore, MEDIA_BUCKET } from "./media-store.js";
export type { MediaStore } from "./media-store.js";
