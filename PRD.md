# Product Requirements Document

## 1. Product goal

Build a cloud-style browser IDE that works for anonymous users without a login screen, while keeping the app stable under real usage, storage pressure, and heavy runtime workloads.

The product must:
- allow anonymous hidden user IDs
- support local-first browser editing through IndexedDB / OPFS
- move heavy workloads to server-side runtime workers only when needed
- isolate user workloads and runtime subsystems
- auto-clean stale data and temp files
- queue work when the system is under pressure
- keep the app usable even when one subsystem is overloaded
- never allow a single user or a single feature to collapse the whole platform

## 1.1 Repository alignment with the product plan

This project already contains the correct architectural direction in the existing backend runtime and config layer.

The current implementation is already organized around:
- shared runtime configuration in [backend/src/lib/backendConfig.ts](backend/src/lib/backendConfig.ts)
- workspace lifecycle and runner scheduling in [backend/src/lib/sessionManager.ts](backend/src/lib/sessionManager.ts)
- GUI session isolation in [backend/src/lib/guiSessionManager.ts](backend/src/lib/guiSessionManager.ts)
- preview isolation in [backend/src/lib/webPreviewSessionManager.ts](backend/src/lib/webPreviewSessionManager.ts)
- queueing and capacity logic across the shared runtime system

The product must be designed to use these existing runtime boundaries rather than turning all workloads into one shared process.

## 2. Core principles

### 2.1 Browser-first, backend-second
The browser is the main interface. The browser should hold local draft state and graceful fallback state.

The backend is responsible for:
- durable workspace storage
- terminal execution
- heavy language runtimes
- GUI sessions
- preview jobs
- APK jobs
- shared user data and queues

### 2.2 Per-user storage must be isolated
Each user should consume a distinct slice of shared server storage, not an unlimited “whatever is available” pool.

This avoids one user filling the system and breaking everyone else.

### 2.3 Burst storage is allowed, but only under healthy conditions
Each user may receive a small base quota and a temporary burst allocation if the system has free capacity.

If the platform becomes pressured, burst space is reclaimed first.

### 2.4 No global single-point failure
If one subsystem fails, the rest of the platform must still work.

Examples:
- runner queue full -> editor still works
- GUI pool full -> app still works
- APK system failing -> code editor and terminal remain active
- storage pressure -> only stale temp data is deleted, not the entire app

### 2.5 Local fallback is mandatory
When backend storage, runtime capacity, or queue pressure is too high, the app must continue functioning in local browser mode for unsynced or light tasks.

## 3. User identity model

### 3.1 Anonymous users for now
No login screen is required for the initial version.

Each browser/device receives a hidden anonymous user ID:
- generated once
- stored in browser storage
- attached to local workspace state
- attached to backend workspace ownership

### 3.2 Privacy and isolation
Anonymous users must be strongly isolated by namespace:
- user workspace root
- runner scratch dir
- cache dir
- temp dir
- artifact dir
- session tokens

This prevents cross-user leakage.

## 4. Storage architecture

## 4.1 Total storage budget for the Oracle instance
The instance is not a single giant user workspace. It is a shared platform.

Recommended working model for a 150 GB instance:

- OS + base system + app files: 25–30 GB
- Docker runtime + base images + toolchains: 20–25 GB
- active shared workspace pool: 35–45 GB
- ephemeral scratch and build folder: 8–12 GB
- APK artifacts and metadata cache: 2–4 GB
- emergency reserve: 10–15 GB
- remaining free headroom for the host and filesystem integrity

This leaves the platform stable without trying to treat all 150 GB as user data capacity.

### 4.1.1 Repository-specific interpretation
The current backend config is already explicitly structured to respect this principle through:
- `WORKSPACE_MAX_BYTES`
- `SHARED_POOL_MAX_BYTES`
- `SHARED_POOL_ADMISSION_BYTES`
- `RUNNER_SCRATCH_MAX_BYTES`
- `STAGING_MAX_BYTES`
- `RUNTIME_CACHE_MAX_BYTES`
- `WORKSPACE_SAFETY_RESERVE_BYTES`
- `PACKAGE_CACHE_MAX_BYTES`
- `GUI_SESSION_MAX_COUNT`
- `PREVIEW_SESSION_MAX_COUNT`
- `APK_JOB_MAX_COUNT`

This means the repository is already headed in the correct direction: enforce boundaries instead of one giant shared folder.

## 4.2 Per-user storage model
Each user receives a quota slice from that shared pool.

Recommended values:
- base workspace quota: 250 MB to 500 MB
- active burst quota: up to 1 GB when the system is healthy
- hard emergency cap: 1–2 GB in shared backend storage during pressure

This keeps a bad actor or heavy user from taking the whole platform.

### 4.2.1 Required behavior for anonymous users
The anonymous user model should follow these rules:
- hidden anonymous user ID stored in browser or session storage
- user workspace folder isolated by user ID
- user active storage tracked by bytes used
- server-side cleanup marks stale workspaces for deletion after inactivity
- when backend storage is pressured, the browser keeps local workspace state active and the user falls back to local editing

This preserves a seamless experience while preventing global fill-up.

## 4.3 Storage tiers
### Tier A: critical system reserve
Used for:
- OS
- app runtime
- backend files
- Docker daemon and runtime images
- host services

This must never be touched for user workspace cleanup.

### Tier B: shared user workspace pool
Used for:
- user files
- active project directories
- editable workspace content
- synced server-backed project data

This is managed by quota and cleanup rules.

### Tier C: temporary runtime storage
Used for:
- runner scratch
- compile output
- build output
- preview caches
- temp logs
- dependency install directories

This should be aggressively pruned.

### Tier D: artifact cache
Used for:
- APK metadata
- generated build result metadata
- temporary export files
- cached previews

Keep only short-lived versions.

## 5. Expiration and cleanup model

### 5.1 Retention windows
For temp and inactive work:
- temp run scratch: delete after run completion, or 30 minutes max
- preview temp assets: delete after 1–6 hours
- logs: delete after 1–24 hours depending on importance
- APK artifacts: delete after 30 minutes to 2 hours unless the user explicitly keeps them
- stale workspaces: delete when inactive beyond 72 hours

### 5.2 Idle detection
Track:
- last active time
- last file write time
- last result access time
- last terminal activity time
- last build / preview / run time

Workspace priority should be based on activity, not just age alone.

### 5.3 Pressure cleanup order
When disk is under pressure, delete in this order:
1. temp run scratch
2. preview cache
3. stale logs
4. old APK artifacts
5. inactive workspace snapshots
6. oldest idle workspace data
7. queue new heavy jobs

This preserves the app while freeing capacity.

## 6. Local fallback model

### 6.1 Browser workspace must stay alive
The browser should always keep a local draft workspace in IndexedDB / OPFS.

This allows:
- editing without server availability
- restore after backend or runner outage
- offline local work while the backend is busy or full
- continuation when the server is in pressure mode

### 6.2 Local mode rules
If the backend workspace pool is full or overloaded, the app should:
- keep the browser workspace active
- show a queue or waiting status
- continue local editing
- delay server work until free capacity exists

This is the fail-safe path for new users and over-capacity situations.

## 7. Queue and concurrency policy

## 7.1 Strict global caps
Heavy work must be queued instead of executed immediately.

Recommended caps for a 5.8 GB RAM host:
- code runner pool: 2 active jobs max
- GUI pool: 1 active session max
- APK pool: 1 active job max
- preview jobs: browser-first, not full server default

This avoids OOM and host-level collapse.

### 7.1.1 Existing repository enforcement
This repo already matches the safe cap model with multiple safeguards already in place:
- `RUNNER_MAX_COUNT` is capped to 2 by default in [backend/src/lib/backendConfig.ts](backend/src/lib/backendConfig.ts)
- `GUI_SESSION_MAX_COUNT` is capped to 1 in the same config file
- `APK_JOB_MAX_COUNT` is capped to 1 in the same config file
- `SESSION_MAX_COUNT` and session TTL logic are enforced in [backend/src/lib/sessionManager.ts](backend/src/lib/sessionManager.ts)

These defaults are not optional; they are the hard-stop protection against server collapse.

## 7.2 Per-user caps
Each user may have a small number of concurrently active jobs:
- 1–2 terminal jobs
- 1 active compile/run job
- 1 preview or GUI session
- 1 APK job

When the cap is exceeded, the app should show queued status instead of failing silently.

## 7.3 Queue semantics
When the system is full:
- show queue position
- keep the editor responsive
- keep local drafting active
- continue non-heavy features
- retry heavy jobs when capacity opens

## 8. Runtime isolation by subsystem

### 8.0 Current repository mapping
The current codebase already reflects the correct subsystem split:
- terminal and workspace orchestration: [backend/src/lib/sessionManager.ts](backend/src/lib/sessionManager.ts)
- GUI display handling: [backend/src/lib/guiSessionManager.ts](backend/src/lib/guiSessionManager.ts)
- web preview orchestration: [backend/src/lib/webPreviewSessionManager.ts](backend/src/lib/webPreviewSessionManager.ts)
- shared system capacity accounting: [backend/src/lib/capacityLedger.ts](backend/src/lib/capacityLedger.ts)
- runtime operation lifecycle and cleanup: [backend/src/lib/operationRegistry.ts](backend/src/lib/operationRegistry.ts)

Each subsystem is separate by design; product logic must preserve this separation and never merge them into a single global runtime pool.

The app must not share one generic runtime pool for all workloads.

### 8.1 Terminal / code runner pool
Used for:
- console execution
- script execution
- dependency installs
- compiler invocations
- build tasks

### 8.2 GUI display pool
Used for:
- Python GUI apps
- Java Swing/AWT apps
- noVNC access
- display sessions

### 8.3 Preview pool
Used for:
- live previews
- frontend preview servers
- static content preview
- browser-based runtime preview

### 8.4 APK pool
Used for:
- metadata extraction
- build scheduling
- packaging jobs
- APK metadata parsing

### 8.5 AI terminal pool
Used for:
- AI command proposal runs
- workspace reads/writes with permission gating
- code execution under sandbox rules

This isolation is required to prevent a single issue from toppling the whole app.

## 9. Failure handling rules

The app must always remain usable even when some subsystems are down.

### 9.1 If the server workspace is full
- local browser draft stays active
- new heavy jobs go to queue or local mode
- old temp data is deleted first
- server-side heavy tasks are delayed

### 9.2 If a runner is overloaded
- retry or queue delayed jobs
- no backend-wide crash
- user sees explicit status

### 9.3 If a GUI session fails
- only that GUI tool fails
- the editor remains active
- terminal and workspace remain active

### 9.4 If an APK job fails
- metadata extraction fails only for that job
- user remains inside the editor
- no server-wide outage

## 10. AI terminal permission model

AI tools must not run unrestricted commands on the host system.

The AI terminal should support:
- workspace-aware reads
- workspace-aware writes
- install approval gates
- command execution under user permission
- approval or rejection of risky actions
- per-session command policy

The AI can help build, edit, and run code, but it must never mutate global platform state without approval.

## 11. Product behavior and UX rules

### 11.1 User sees queue instead of failure
When overloaded, the app should say:
- queued
- waiting for available runner
- waiting for storage headroom
- local fallback active

### 11.2 User gets warnings before destructive cleanup
Before deleting a workspace or temporary data:
- show countdown warning
- show restore option
- give a short undo window if possible

### 11.3 Data recovery window
Users should be able to restore deleted data for a short time window after cleanup trigger.

### 11.4 Keep the app alive even while resource pressure exists
The app must keep the editor, error states, and non-heavy local tools working even when heavy jobs are queued.

## 12. Non-goals and exclusions

### 12.1 What not to do in this product
The following must be rejected or treated as local-only fallback:
- unlimited shared server workspace for every user
- one giant global runner pool
- letting all language runtimes run without separate queue caps
- using browser-only execution for heavy multi-user workloads
- allowing AI to mutate the server globally without approval
- allowing stale temp data to live forever

This is the core reason earlier versions failed: the system tried to behave like a giant single container for too many jobs.

The following should not be treated as stable default capabilities in the first version:
- fully browser-only heavy runtime execution for all languages
- unrestricted global terminal access by AI
- unlimited server workspace size per user
- unlimited heavy app sessions for all users
- unlimited APK background processing without queueing
- unlimited GUI or preview sessions without dedicated worker caps

These should be treated as queued or browser-local features, not default shared server features.

## 13. Recommended roadmap

### Phase 1: Stable anonymous editor
- anonymous user IDs
- local browser draft storage
- backend workspace with small quota
- queue for heavy commands
- cleanup workers
- pressure detection

### Phase 2: Real runtime isolation
- separate terminal runner pool
- separate GUI pool
- separate preview pool
- separate APK worker
- short-lived scratch deletion

### Phase 3: AI + permissions
- AI approval flow
- terminal permission gates
- workspace validation for AI actions
- safe command execution enforcement

### Phase 4: Scale and resilience
- autoscaling worker pools
- larger storage headroom planning
- hardened cleanup policies
- per-user quota tuning

## 14. Final recommendation

This product is viable only if it follows a strict hybrid model:
- local browser workspace for fallback and editing
- backend workspace with small quota slices
- isolated runtime pools for each heavy task
- queue and pressure logic for all heavy jobs
- storage tiering and auto-cleanup
- anonymous user IDs with per-user namespace isolation
- no single subsystem can crash the entire app

This is the correct design for your product and protects against the problems already seen in the current architecture.
