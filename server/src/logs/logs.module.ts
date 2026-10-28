import {
  forwardRef,
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import * as express from 'express';
import { AiToolVersionsModule } from '../ai-tool-versions/ai-tool-versions.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { LOG_INGEST_ROUTES } from '../common/body-limits';
import { throwMiddlewareErrors } from '../common/middleware-errors';
import { getLogsBodyLimit } from '../common/logs-body-limit';
import { TeamsModule } from '../teams/teams.module';
import { ActiveSessionsService } from './analytics/active-sessions.service';
import { ClaudeVersionUsageService } from './analytics/claude-version-usage.service';
import { ProductivityAnalyticsService } from './analytics/productivity-analytics.service';
import { TokenAnalyticsService } from './analytics/token-analytics.service';
import { ToolAnalyticsService } from './analytics/tool-analytics.service';
import { UsageAnalyticsController } from './analytics/usage-analytics.controller';
import { ChangeSurfaceAggregateService } from './change-surface/change-surface-aggregate.service';
import { ChangeSurfaceService } from './change-surface/change-surface.service';
import { ExportImportJobCleanupScheduler } from './export-import-job-cleanup.scheduler';
import { ExportImportJobsService } from './export-import-jobs.service';
import { HookStateService } from './hook-state.service';
import { LogsController } from './logs.controller';
import { LogsV2Controller } from './logs-v2.controller';
import { LogsService } from './logs.service';
import { ModelPricingController } from './model-pricing.controller';
import { OkfFactsController } from './okf/okf-facts.controller';
import { OkfFactsService } from './okf/okf-facts.service';
import { OkfUsageService } from './okf/okf-usage.service';
import { RepoBackfillService } from './repo-backfill.service';
import { RepositoriesController } from './repositories.controller';
import { RepositoriesService } from './repositories.service';
import { RepositoryExportImportController } from './repository-export-import.controller';
import { RepositoryExportImportService } from './repository-export-import.service';
import { AttributionBreakdownService } from './reports/attribution-breakdown.service';
import { AttributionUsageService } from './reports/attribution-usage.service';
import { CacheReadRatioService } from './reports/cache-read-ratio.service';
import { ChangeSurfaceReportService } from './reports/change-surface-report.service';
import { ExecutiveSummaryService } from './reports/executive-summary.service';
import { HarnessUsageService } from './reports/harness-usage.service';
import { ReportsController } from './reports/reports.controller';
import { SessionAttributionModule } from './session-attribution/session-attribution.module';
import { SessionCostRecomputeService } from './session-cost/session-cost-recompute.service';
import { UploadQueueSchedulerService } from './upload-queue-scheduler.service';
import { UploadQueueService } from './upload-queue.service';

@Module({
  imports: [
    // Claude Code version usage report reads the release history via AiToolVersionsService.
    AiToolVersionsModule,
    ApiKeysModule,
    ScheduleModule.forRoot(),
    forwardRef(() => TeamsModule),
    // RepositoriesController's getRepositorySessions()/
    // session-attribution/values need SessionAttributionService (resolveDefinitions() for
    // attr= filter validation + orphan stripping). SessionAttributionModule itself
    // forwardRef()s back to this module for RepositoriesService, so both sides use
    // forwardRef() to break the cycle — same shape Nest expects for any circular module pair.
    forwardRef(() => SessionAttributionModule),
  ],
  controllers: [
    LogsController,
    LogsV2Controller,
    ModelPricingController,
    OkfFactsController,
    RepositoriesController,
    RepositoryExportImportController,
    ReportsController,
    UsageAnalyticsController,
  ],
  providers: [
    LogsService,
    RepositoriesService,
    RepoBackfillService,
    HookStateService,
    UploadQueueService,
    UploadQueueSchedulerService,
    RepositoryExportImportService,
    ExportImportJobsService,
    ExportImportJobCleanupScheduler,
    ExecutiveSummaryService,
    CacheReadRatioService,
    HarnessUsageService,
    AttributionBreakdownService,
    AttributionUsageService,
    // Usage analytics — shared by the four analytics/* routes and the four reports/*
    // routes, so both return byte-identical DTOs.
    ToolAnalyticsService,
    TokenAnalyticsService,
    ProductivityAnalyticsService,
    ActiveSessionsService,
    // Claude Code version usage — shared by analytics/claude-versions and its reports/ twin.
    ClaudeVersionUsageService,
    // Change surface — one metric definition, three readers: the session tab/summary
    // (ChangeSurfaceService), the shared multi-session fold behind both the report and the
    // analytics chart (ChangeSurfaceAggregateService), and the report assembled on top of
    // that same fold, so the two can never disagree.
    ChangeSurfaceService,
    ChangeSurfaceAggregateService,
    ChangeSurfaceReportService,
    // Stored session costs: sweeps stale session_costs rows (pricing changes, moved
    // top-ancestor price dates) and serves the pricing writers' drain signal.
    SessionCostRecomputeService,
    // OKF (knowledge base) usage — the session tab and repo report (OkfUsageService) and
    // the API-key facts route (OkfFactsService).
    OkfUsageService,
    OkfFactsService,
  ],
  exports: [RepositoriesService, HookStateService, UploadQueueService],
})
export class LogsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // The log-ingest routes are excluded from the global GLOBAL_BODY_LIMIT parsers in
    // app.module.ts and parse here at the logs limit. Root-module
    // middleware (the gzip sniffer) is registered before this module's.
    // throwMiddlewareErrors keeps a parser's 413/400 from being rewritten to 404.
    const limit = getLogsBodyLimit();
    consumer
      .apply(
        throwMiddlewareErrors(express.json({ limit })),
        throwMiddlewareErrors(
          express.text({
            type: ['application/x-ndjson', 'text/plain'],
            limit,
          }),
        ),
        throwMiddlewareErrors(express.urlencoded({ extended: true, limit })),
      )
      .forRoutes(...LOG_INGEST_ROUTES);
  }
}
