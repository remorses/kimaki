-- Schema of a real V1 Kimaki install (~/.kimaki/discord-sessions.db), dumped with sqlite3 .schema.
-- Used by db.test.ts to prove V2 opens old databases without touching V1-only tables.
CREATE TABLE thread_sessions (
    thread_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  , source TEXT DEFAULT 'kimaki', last_synced_name TEXT, parent_session_id TEXT, updated_at DATETIME);
CREATE TABLE part_messages (
    part_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
CREATE TABLE bot_tokens (
        app_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      , bot_mode TEXT DEFAULT 'self-hosted', client_id TEXT, client_secret TEXT, proxy_url TEXT, last_used_at DATETIME);
CREATE TABLE channel_directories (
        channel_id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      , app_id TEXT, guild_id TEXT);
CREATE TABLE bot_api_keys (
        app_id TEXT PRIMARY KEY,
        gemini_api_key TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      , xai_api_key TEXT, openai_api_key TEXT);
CREATE TABLE channel_models (
      channel_id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    , variant TEXT);
CREATE TABLE session_models (
      session_id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    , variant TEXT);
CREATE TABLE channel_agents (
      channel_id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE session_agents (
      session_id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE pending_auto_start (
        thread_id TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
CREATE TABLE thread_worktrees (
        thread_id TEXT PRIMARY KEY,
        worktree_name TEXT NOT NULL,
        worktree_directory TEXT,
        project_directory TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
CREATE TABLE pending_questions (
      context_hash TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      request_id TEXT NOT NULL,
      questions_json TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      total_questions INTEGER NOT NULL,
      answered_count INTEGER NOT NULL,
      channel_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE channel_worktrees (
      channel_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE channel_verbosity (
      channel_id TEXT PRIMARY KEY,
      verbosity TEXT NOT NULL DEFAULT 'tools-and-text',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE IF NOT EXISTS "global_models" (
    "app_id" TEXT NOT NULL PRIMARY KEY,
    "model_id" TEXT NOT NULL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP, variant TEXT,
    CONSTRAINT "global_models_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "bot_tokens" ("app_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "channel_mention_mode" (
    "channel_id" TEXT NOT NULL PRIMARY KEY,
    "enabled" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "channel_mention_mode_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channel_directories" ("channel_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "session_thinking" (
    "session_id" TEXT NOT NULL PRIMARY KEY,
    "thinking_value" TEXT NOT NULL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "forum_sync_configs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "app_id" TEXT NOT NULL,
    "forum_channel_id" TEXT NOT NULL,
    "output_dir" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'bidirectional',
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "forum_sync_configs_app_id_forum_channel_id_key" ON "forum_sync_configs"("app_id", "forum_channel_id");
CREATE TABLE IF NOT EXISTS "scheduled_tasks" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "schedule_kind" TEXT NOT NULL,
    "run_at" DATETIME,
    "cron_expr" TEXT,
    "timezone" TEXT,
    "next_run_at" DATETIME NOT NULL,
    "running_started_at" DATETIME,
    "last_run_at" DATETIME,
    "last_error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "payload_json" TEXT NOT NULL,
    "prompt_preview" TEXT NOT NULL,
    "channel_id" TEXT,
    "thread_id" TEXT,
    "session_id" TEXT,
    "project_directory" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "scheduled_tasks_status_next_run_at_idx" ON "scheduled_tasks"("status", "next_run_at");
CREATE INDEX "scheduled_tasks_channel_id_status_idx" ON "scheduled_tasks"("channel_id", "status");
CREATE TABLE IF NOT EXISTS "session_start_sources" (
    "session_id" TEXT NOT NULL PRIMARY KEY,
    "schedule_kind" TEXT NOT NULL,
    "scheduled_task_id" INTEGER,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "scheduled_tasks_thread_id_status_idx" ON "scheduled_tasks"("thread_id", "status");
CREATE INDEX "session_start_sources_scheduled_task_id_idx" ON "session_start_sources"("scheduled_task_id");
CREATE TABLE IF NOT EXISTS "bot_instances" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "pid" INTEGER NOT NULL,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "ipc_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "response" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ipc_requests_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread_sessions" ("thread_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ipc_requests_status_created_at_idx" ON "ipc_requests"("status", "created_at");
CREATE TABLE IF NOT EXISTS "session_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "session_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "event_index" INTEGER NOT NULL,
    "event_json" TEXT NOT NULL,
    CONSTRAINT "session_events_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread_sessions" ("thread_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "session_events_session_id_timestamp_event_index_id_idx" ON "session_events"("session_id", "timestamp", "event_index", "id");
CREATE INDEX "session_events_thread_id_timestamp_event_index_id_idx" ON "session_events"("thread_id", "timestamp", "event_index", "id");
CREATE TABLE `thread_workspaces` (
	`thread_id` text PRIMARY KEY,
	`workspace_id` text,
	`workspace_type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`project_directory` text NOT NULL,
	`workspace_directory` text,
	`workspace_name` text NOT NULL,
	`created_at` datetime DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `fk_thread_workspaces_thread_id_thread_sessions_thread_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `thread_sessions`(`thread_id`) ON UPDATE CASCADE
);
CREATE TABLE `default_channel_provisions` (
	`app_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` datetime DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `default_channel_provisions_pk` PRIMARY KEY(`app_id`, `guild_id`)
);
CREATE TABLE `scheduled_task_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`scheduled_task_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`thread_id` text,
	`session_id` text,
	`project_directory` text,
	`started_at` datetime NOT NULL,
	`completed_at` datetime,
	`error` text,
	CONSTRAINT `fk_scheduled_task_runs_scheduled_task_id_scheduled_tasks_id_fk` FOREIGN KEY (`scheduled_task_id`) REFERENCES `scheduled_tasks`(`id`) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX `scheduled_task_runs_task_status_idx` ON `scheduled_task_runs` (`scheduled_task_id`,`status`);
CREATE INDEX `scheduled_task_runs_session_status_idx` ON `scheduled_task_runs` (`session_id`,`status`);
CREATE TABLE `session_sleeps` (
	`session_id` text PRIMARY KEY,
	`wake_at` datetime NOT NULL,
	`reason` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`delivery_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` datetime,
	`created_at` datetime DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX `session_sleeps_status_wake_at_idx` ON `session_sleeps` (`status`,`wake_at`);
CREATE TABLE `session_system_contexts` (
	`session_id` text PRIMARY KEY,
	`payload` text NOT NULL,
	`updated_at` datetime DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `guild_categories` (
	`guild_id` text PRIMARY KEY,
	`category_id` text,
	`audio_category_id` text,
	`created_at` datetime DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE thread_queue_items (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      queue_id text NOT NULL UNIQUE,
      thread_id text NOT NULL,
      payload_json text NOT NULL,
      created_at datetime DEFAULT CURRENT_TIMESTAMP
    );
CREATE INDEX thread_queue_items_thread_id_id_idx ON thread_queue_items (thread_id, id);
