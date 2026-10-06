use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use sk_coder_contracts::{
    evaluate_admission, AdmissionDecision, AdmissionError, ApiError, ApiErrorCode,
    CapacitySnapshot, CodeRunRequest, CodeRunResult, CreateOperationRequest,
    CreateWorkspaceRequest, GlobalLimits, OperationRecord, OperationState, ResourceTotals,
    RuntimeState, WorkspaceCreated, WorkspaceFileInfo, WorkspaceFileOperationRequest,
    WorkspaceFileRequest, WorkspaceRecord, WorkspaceState, WorkspaceSummary, BASE_WORKSPACE_BYTES,
    BURST_WORKSPACE_BYTES, CONTRACT_SCHEMA_VERSION,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalCommandRequest {
    pub command: String,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub execution_time_ms: u64,
}

pub fn default_limits() -> GlobalLimits {
    GlobalLimits {
        workspace_base_bytes: BASE_WORKSPACE_BYTES,
        workspace_burst_bytes: BURST_WORKSPACE_BYTES,
        max_burst_seconds: 3600,
        max_active_workspaces: 6,
        max_concurrent_operations: 2,
        max_queued_operations: 20,
        shared_pool_max_bytes: 50 * 1024 * 1024 * 1024,
        shared_pool_admission_bytes: 48 * 1024 * 1024 * 1024,
        safety_reserve_bytes: 75 * 1024 * 1024 * 1024,
        max_total_cpu_millis: 4000,
        max_total_memory_bytes: 20 * 1024 * 1024 * 1024,
        max_total_pids: 1536,
        max_operation_cpu_millis: 1000,
        max_operation_memory_bytes: 4 * 1024 * 1024 * 1024,
        max_operation_pids: 256,
        max_operation_scratch_bytes: 3 * 1024 * 1024 * 1024,
        max_execution_ms: 180_000,
        max_output_bytes: 500_000,
    }
}

#[derive(Clone, Debug)]
pub struct AppState {
    limits: GlobalLimits,
    runtime_image: String,
    workspaces: Arc<Mutex<HashMap<String, WorkspaceRecord>>>,
    operations: Arc<Mutex<BTreeMap<String, OperationRecord>>>,
    queue_sequence: Arc<Mutex<u64>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            limits: default_limits(),
            runtime_image: std::env::var("RUNTIME_IMAGE")
                .unwrap_or_else(|_| "sk-coder-runtime:latest".to_string()),
            workspaces: Arc::new(Mutex::new(HashMap::new())),
            operations: Arc::new(Mutex::new(BTreeMap::new())),
            queue_sequence: Arc::new(Mutex::new(0)),
        }
    }

    fn sha256_hex(value: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(value.as_bytes());
        format!("{:x}", hasher.finalize())
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    pub fn workspace_root_for(workspace_id: &str) -> String {
        std::env::temp_dir()
            .join("skcoder-workspaces")
            .join(workspace_id)
            .to_string_lossy()
            .into_owned()
    }

    pub fn container_name_for(workspace_id: &str) -> String {
        let normalized: String = workspace_id
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric())
            .collect();
        format!("skcoder-{normalized}")
    }

    fn docker_command(args: &[&str]) -> Result<std::process::Output, std::io::Error> {
        Command::new("docker").args(args).output()
    }

    pub fn runtime_is_active(&self, workspace_id: &str) -> bool {
        let output = Self::docker_command(&[
            "inspect",
            "-f",
            "{{.State.Running}}",
            &Self::container_name_for(workspace_id),
        ]);
        match output {
            Ok(output) => {
                output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true"
            }
            Err(_) => false,
        }
    }

    pub fn start_runtime_for_workspace(
        &self,
        workspace_id: &str,
        workspace_root: &str,
    ) -> Result<(), ApiError> {
        if fs::create_dir_all(workspace_root).is_err() {
            return Err(Self::make_api_error(
                ApiErrorCode::InternalError,
                "unable to create workspace root",
                false,
            ));
        }

        let output = Self::docker_command(&[
            "run",
            "-d",
            "--rm",
            "--name",
            &Self::container_name_for(workspace_id),
            "--memory",
            "768m",
            "--memory-swap",
            "768m",
            "--cpus",
            "1",
            "--pids-limit",
            "256",
            "--network",
            "none",
            "-v",
            &format!("{workspace_root}:/workspace:rw"),
            "-w",
            "/workspace",
            &self.runtime_image,
            "sleep",
            "infinity",
        ]);

        match output {
            Ok(result) if result.status.success() => Ok(()),
            Ok(result) => Err(Self::make_api_error(
                ApiErrorCode::InternalError,
                format!(
                    "workspace runtime failed to start: {}",
                    String::from_utf8_lossy(&result.stderr)
                ),
                true,
            )),
            Err(_) => Err(Self::make_api_error(
                ApiErrorCode::InternalError,
                "docker is unavailable for runtime startup",
                true,
            )),
        }
    }

    pub fn suspend_runtime_for_workspace(&self, workspace_id: &str) -> Result<(), ApiError> {
        let output = Self::docker_command(&["rm", "-f", &Self::container_name_for(workspace_id)]);
        match output {
            Ok(_) => Ok(()),
            Err(_) => Err(Self::make_api_error(
                ApiErrorCode::InternalError,
                "docker is unavailable for runtime shutdown",
                true,
            )),
        }
    }

    fn make_api_error(kind: ApiErrorCode, message: impl Into<String>, retryable: bool) -> ApiError {
        ApiError {
            code: kind,
            message: message.into(),
            retryable,
            details: None,
        }
    }

    fn snapshot(&self) -> CapacitySnapshot {
        let workspaces = self.workspaces.lock().unwrap();
        let operations = self.operations.lock().unwrap();

        let mut active_resources = ResourceTotals::default();
        let mut reserved_shared_bytes = 0u64;

        for record in operations.values() {
            let is_terminal = matches!(
                record.state,
                OperationState::Complete
                    | OperationState::Failed
                    | OperationState::Cancelled
                    | OperationState::Expired
            );
            if is_terminal {
                continue;
            }
            active_resources.cpu_millis = active_resources
                .cpu_millis
                .saturating_add(record.resources.cpu_millis);
            active_resources.memory_bytes = active_resources
                .memory_bytes
                .saturating_add(record.resources.memory_bytes);
            active_resources.pids = active_resources.pids.saturating_add(record.resources.pids);
            reserved_shared_bytes =
                reserved_shared_bytes.saturating_add(record.resources.reservation_bytes);
        }

        CapacitySnapshot {
            active_workspaces: workspaces.len() as u32,
            active_operations: operations
                .values()
                .filter(|record| {
                    !matches!(
                        record.state,
                        OperationState::Complete
                            | OperationState::Failed
                            | OperationState::Cancelled
                            | OperationState::Expired
                    )
                })
                .count() as u32,
            queued_operations: operations
                .values()
                .filter(|record| record.state == OperationState::Queued)
                .count() as u32,
            reserved_shared_bytes,
            filesystem_free_bytes: 150 * 1024 * 1024 * 1024,
            active_resources,
        }
    }

    pub fn create_workspace(
        &self,
        request: &CreateWorkspaceRequest,
    ) -> Result<WorkspaceCreated, ApiError> {
        let mut workspaces = self.workspaces.lock().unwrap();
        if workspaces.len() as u32 >= self.limits.max_active_workspaces {
            return Err(Self::make_api_error(
                ApiErrorCode::WorkspaceQuotaExceeded,
                "workspace limit reached for this host",
                true,
            ));
        }

        let now = Self::now_ms();
        let retention_seconds = request.retention_seconds.unwrap_or(60 * 60).min(86_400);
        let workspace_id = Uuid::new_v4().to_string();
        let access_token = format!("sk_ws_{}_{:x}", Uuid::new_v4(), now);
        let access_token_sha256 = Self::sha256_hex(&access_token);

        let record = WorkspaceRecord {
            schema_version: CONTRACT_SCHEMA_VERSION,
            workspace_id: workspace_id.clone(),
            access_token_sha256,
            created_at_ms: now,
            expires_at_ms: now.saturating_add(retention_seconds as u64 * 1000),
            state: WorkspaceState::Active,
            runtime_state: RuntimeState::Suspended,
            revision: 0,
            bytes_used: 0,
            base_quota_bytes: self.limits.workspace_base_bytes,
            burst_quota_bytes: self.limits.workspace_burst_bytes,
            burst_expires_at_ms: None,
        };
        workspaces.insert(workspace_id.clone(), record);

        Ok(WorkspaceCreated {
            workspace_id,
            access_token,
            created_at_ms: now,
            expires_at_ms: now.saturating_add(retention_seconds as u64 * 1000),
            state: WorkspaceState::Active,
        })
    }

    pub fn get_workspace(&self, workspace_id: &str) -> Result<WorkspaceSummary, ApiError> {
        let workspaces = self.workspaces.lock().unwrap();
        let record = workspaces.get(workspace_id).cloned().ok_or_else(|| {
            Self::make_api_error(
                ApiErrorCode::WorkspaceNotFound,
                "workspace not found",
                false,
            )
        })?;

        Ok(WorkspaceSummary {
            workspace_id: record.workspace_id,
            created_at_ms: record.created_at_ms,
            expires_at_ms: record.expires_at_ms,
            state: record.state,
            runtime_state: record.runtime_state,
            revision: record.revision,
            bytes_used: record.bytes_used,
            base_quota_bytes: record.base_quota_bytes,
            burst_quota_bytes: record.burst_quota_bytes,
            burst_expires_at_ms: record.burst_expires_at_ms,
        })
    }

    pub fn delete_workspace(
        &self,
        workspace_id: &str,
        access_token: &str,
    ) -> Result<WorkspaceSummary, ApiError> {
        let mut workspaces = self.workspaces.lock().unwrap();
        let mut record = self.validate_workspace_access(workspace_id, access_token)?;
        record.state = WorkspaceState::ScheduledDelete;
        record.revision = record.revision.saturating_add(1);
        workspaces.insert(workspace_id.to_string(), record.clone());
        Ok(WorkspaceSummary {
            workspace_id: record.workspace_id,
            created_at_ms: record.created_at_ms,
            expires_at_ms: record.expires_at_ms,
            state: record.state,
            runtime_state: record.runtime_state,
            revision: record.revision,
            bytes_used: record.bytes_used,
            base_quota_bytes: record.base_quota_bytes,
            burst_quota_bytes: record.burst_quota_bytes,
            burst_expires_at_ms: record.burst_expires_at_ms,
        })
    }

    pub fn validate_workspace_access(
        &self,
        workspace_id: &str,
        access_token: &str,
    ) -> Result<WorkspaceRecord, ApiError> {
        let workspaces = self.workspaces.lock().unwrap();
        let workspace = workspaces.get(workspace_id).cloned().ok_or_else(|| {
            Self::make_api_error(
                ApiErrorCode::WorkspaceNotFound,
                "workspace not found",
                false,
            )
        })?;

        let provided = Self::sha256_hex(access_token);
        if provided != workspace.access_token_sha256 {
            return Err(Self::make_api_error(
                ApiErrorCode::Unauthorized,
                "invalid workspace capability",
                false,
            ));
        }

        Ok(workspace)
    }

    pub fn create_operation(
        &self,
        workspace_id: &str,
        access_token: &str,
        request: &CreateOperationRequest,
    ) -> Result<OperationRecord, ApiError> {
        let _workspace = self.validate_workspace_access(workspace_id, access_token)?;

        let now = Self::now_ms();
        let mut operation = OperationRecord {
            schema_version: CONTRACT_SCHEMA_VERSION,
            operation_id: Uuid::new_v4().to_string(),
            workspace_id: workspace_id.to_string(),
            kind: request.kind.clone(),
            state: OperationState::Created,
            created_at_ms: now,
            updated_at_ms: now,
            queue_sequence: None,
            progress_percent: None,
            resources: request.resources.clone(),
            error_code: None,
            error_message: None,
        };

        let admission = evaluate_admission(
            &self.limits,
            &self.snapshot(),
            &sk_coder_contracts::AdmissionRequest {
                resources: request.resources.clone(),
                needs_workspace_slot: false,
                workspace_bytes_after: None,
                burst_expires_at_ms: None,
                now_ms: now,
            },
        )
        .map_err(|err| match err {
            AdmissionError::InvalidLimits => {
                Self::make_api_error(ApiErrorCode::InternalError, "invalid host limits", false)
            }
            AdmissionError::InvalidResourceRequest => Self::make_api_error(
                ApiErrorCode::InvalidRequest,
                "invalid resource request",
                false,
            ),
            AdmissionError::OperationResourceLimit => Self::make_api_error(
                ApiErrorCode::InvalidRequest,
                "operation exceeds host limits",
                false,
            ),
            AdmissionError::WorkspaceLimit => Self::make_api_error(
                ApiErrorCode::WorkspaceQuotaExceeded,
                "workspace limit reached",
                true,
            ),
            AdmissionError::WorkspaceQuotaExceeded => Self::make_api_error(
                ApiErrorCode::WorkspaceQuotaExceeded,
                "workspace quota exceeded",
                true,
            ),
            AdmissionError::InvalidBurstLease => {
                Self::make_api_error(ApiErrorCode::InvalidRequest, "invalid burst lease", false)
            }
            AdmissionError::SharedCapacityUnavailable => Self::make_api_error(
                ApiErrorCode::SharedCapacityUnavailable,
                "shared capacity unavailable",
                true,
            ),
            AdmissionError::HostSafetyReserve => Self::make_api_error(
                ApiErrorCode::HostSafetyReserve,
                "host safety reserve breached",
                true,
            ),
            AdmissionError::QueueFull => {
                Self::make_api_error(ApiErrorCode::QueueFull, "global queue is full", true)
            }
        })?;

        let queued_sequence = match admission {
            AdmissionDecision::AdmitNow => None,
            AdmissionDecision::Queue => {
                let mut seq = self.queue_sequence.lock().unwrap();
                *seq += 1;
                Some(*seq)
            }
        };

        operation.state = OperationState::Queued;
        operation.queue_sequence = queued_sequence;
        operation.updated_at_ms = now;

        let mut operations = self.operations.lock().unwrap();
        operations.insert(operation.operation_id.clone(), operation.clone());
        Ok(operation)
    }

    pub fn get_operation(
        &self,
        workspace_id: &str,
        access_token: &str,
        operation_id: &str,
    ) -> Result<OperationRecord, ApiError> {
        self.validate_workspace_access(workspace_id, access_token)?;
        let operations = self.operations.lock().unwrap();
        let operation = operations.get(operation_id).cloned().ok_or_else(|| {
            Self::make_api_error(
                ApiErrorCode::WorkspaceNotFound,
                "operation not found",
                false,
            )
        })?;

        if operation.workspace_id != workspace_id {
            return Err(Self::make_api_error(
                ApiErrorCode::WorkspaceNotFound,
                "operation not found for this workspace",
                false,
            ));
        }

        Ok(operation)
    }

    pub fn cancel_operation(
        &self,
        workspace_id: &str,
        access_token: &str,
        operation_id: &str,
    ) -> Result<OperationRecord, ApiError> {
        self.validate_workspace_access(workspace_id, access_token)?;
        let mut operations = self.operations.lock().unwrap();
        let mut operation = operations.get(operation_id).cloned().ok_or_else(|| {
            Self::make_api_error(
                ApiErrorCode::WorkspaceNotFound,
                "operation not found",
                false,
            )
        })?;

        if operation.workspace_id != workspace_id {
            return Err(Self::make_api_error(
                ApiErrorCode::WorkspaceNotFound,
                "operation not found for this workspace",
                false,
            ));
        }

        let now = Self::now_ms();
        operation
            .transition(OperationState::Cancelled, now)
            .map_err(|_| {
                Self::make_api_error(
                    ApiErrorCode::OperationConflict,
                    "operation cannot be cancelled in its current state",
                    false,
                )
            })?;
        operations.insert(operation_id.to_string(), operation.clone());
        Ok(operation)
    }

    pub fn run_command_in_workspace(
        &self,
        workspace_id: &str,
        access_token: &str,
        request: &TerminalCommandRequest,
    ) -> Result<TerminalCommandResult, ApiError> {
        self.validate_workspace_access(workspace_id, access_token)?;

        let container_name = Self::container_name_for(workspace_id);
        let cwd = request
            .cwd
            .clone()
            .unwrap_or_else(|| "/workspace".to_string());
        let command = request.command.trim();
        if command.is_empty() {
            return Err(Self::make_api_error(
                ApiErrorCode::InvalidRequest,
                "command is required",
                false,
            ));
        }

        if !self.runtime_is_active(workspace_id) {
            return Err(Self::make_api_error(
                ApiErrorCode::InternalError,
                format!("workspace runtime is not running: {container_name}"),
                true,
            ));
        }

        let started = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let output = Command::new("docker")
            .args([
                "exec",
                "--workdir",
                &cwd,
                &container_name,
                "bash",
                "-lc",
                command,
            ])
            .output();

        let elapsed = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64)
            .saturating_sub(started);

        match output {
            Ok(result) => Ok(TerminalCommandResult {
                stdout: String::from_utf8_lossy(&result.stdout).to_string(),
                stderr: String::from_utf8_lossy(&result.stderr).to_string(),
                exit_code: result.status.code().unwrap_or(1),
                execution_time_ms: elapsed,
            }),
            Err(_) => Err(Self::make_api_error(
                ApiErrorCode::InternalError,
                "docker is unavailable for command execution",
                true,
            )),
        }
    }

    fn workspace_path(&self, workspace_id: &str) -> Result<PathBuf, ApiError> {
        let root = PathBuf::from(Self::workspace_root_for(workspace_id));
        let canonical = root.canonicalize().map_err(|_| {
            Self::make_api_error(
                ApiErrorCode::WorkspaceNotFound,
                "workspace runtime is unavailable",
                false,
            )
        })?;
        if !canonical.is_dir() {
            return Err(Self::make_api_error(
                ApiErrorCode::WorkspaceNotFound,
                "workspace runtime is unavailable",
                false,
            ));
        }
        Ok(canonical)
    }

    fn workspace_file_path(
        &self,
        workspace_id: &str,
        requested: &str,
    ) -> Result<PathBuf, ApiError> {
        let root = self.workspace_path(workspace_id)?;
        let path = Path::new(requested);
        if path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err(Self::make_api_error(
                ApiErrorCode::InvalidRequest,
                "workspace path must be relative",
                false,
            ));
        }
        let target = root.join(path);
        if target.is_symlink() {
            return Err(Self::make_api_error(
                ApiErrorCode::InvalidRequest,
                "workspace path must not be a symlink",
                false,
            ));
        }
        let mut current = root.clone();
        for component in path.components() {
            current.push(component.as_os_str());
            if current.exists() {
                if current
                    .symlink_metadata()
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
                {
                    return Err(Self::make_api_error(
                        ApiErrorCode::InvalidRequest,
                        "workspace path must not contain a symlink",
                        false,
                    ));
                }
                let canonical = current.canonicalize().map_err(|_| {
                    Self::make_api_error(
                        ApiErrorCode::InvalidRequest,
                        "workspace path is unavailable",
                        false,
                    )
                })?;
                if !canonical.starts_with(&root) || !canonical.is_dir() && current != target {
                    return Err(Self::make_api_error(
                        ApiErrorCode::InvalidRequest,
                        "workspace path escapes the workspace",
                        false,
                    ));
                }
            }
        }
        Ok(target)
    }

    pub fn list_workspace_files(
        &self,
        workspace_id: &str,
        access_token: &str,
    ) -> Result<Vec<WorkspaceFileInfo>, ApiError> {
        self.validate_workspace_access(workspace_id, access_token)?;
        let root = self.workspace_path(workspace_id)?;
        let mut files = Vec::new();
        for entry in fs::read_dir(&root).map_err(|_| {
            Self::make_api_error(
                ApiErrorCode::WorkspaceNotFound,
                "workspace files are unavailable",
                false,
            )
        })? {
            let entry = entry.map_err(|_| {
                Self::make_api_error(
                    ApiErrorCode::InternalError,
                    "unable to read workspace entries",
                    false,
                )
            })?;
            let metadata = entry.metadata().map_err(|_| {
                Self::make_api_error(
                    ApiErrorCode::InternalError,
                    "unable to inspect workspace entry",
                    false,
                )
            })?;
            if metadata.is_file() {
                let path = entry.path();
                let relative = path.strip_prefix(&root).map_err(|_| {
                    Self::make_api_error(
                        ApiErrorCode::InvalidRequest,
                        "workspace path escapes the workspace",
                        false,
                    )
                })?;
                files.push(WorkspaceFileInfo {
                    path: relative.to_string_lossy().replace('\\', "/"),
                    size: metadata.len(),
                    file_type: "file".to_string(),
                });
            }
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(files)
    }

    pub fn write_workspace_file(
        &self,
        workspace_id: &str,
        access_token: &str,
        request: &WorkspaceFileRequest,
    ) -> Result<WorkspaceFileInfo, ApiError> {
        self.validate_workspace_access(workspace_id, access_token)?;
        let target = self.workspace_file_path(workspace_id, &request.path)?;
        if request.path.trim().is_empty() || request.path.len() > 4096 {
            return Err(Self::make_api_error(
                ApiErrorCode::InvalidRequest,
                "invalid workspace file path",
                false,
            ));
        }
        if request.encoding.as_deref() != Some("utf8") && request.encoding.is_some() {
            return Err(Self::make_api_error(
                ApiErrorCode::InvalidRequest,
                "only utf8 file encoding is supported",
                false,
            ));
        }
        let bytes = request.content.as_bytes();
        if bytes.len() > 5 * 1024 * 1024 {
            return Err(Self::make_api_error(
                ApiErrorCode::InvalidRequest,
                "workspace file exceeds 5 MB",
                false,
            ));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| {
                Self::make_api_error(
                    ApiErrorCode::InternalError,
                    "unable to create workspace directory",
                    false,
                )
            })?;
        }
        fs::write(&target, bytes).map_err(|_| {
            Self::make_api_error(
                ApiErrorCode::InternalError,
                "unable to write workspace file",
                false,
            )
        })?;
        Ok(WorkspaceFileInfo {
            path: request.path.clone(),
            size: bytes.len() as u64,
            file_type: "file".to_string(),
        })
    }

    pub fn move_workspace_file(
        &self,
        workspace_id: &str,
        access_token: &str,
        request: &WorkspaceFileOperationRequest,
    ) -> Result<WorkspaceFileInfo, ApiError> {
        self.validate_workspace_access(workspace_id, access_token)?;
        let source = self.workspace_file_path(workspace_id, &request.path)?;
        let target = self.workspace_file_path(
            workspace_id,
            request.target_path.as_deref().unwrap_or(&request.path),
        )?;
        if !source.exists() || !source.is_file() {
            return Err(Self::make_api_error(
                ApiErrorCode::WorkspaceNotFound,
                "workspace file not found",
                false,
            ));
        }
        if source == target {
            return Err(Self::make_api_error(
                ApiErrorCode::InvalidRequest,
                "source and destination are identical",
                false,
            ));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| {
                Self::make_api_error(
                    ApiErrorCode::InternalError,
                    "unable to create workspace directory",
                    false,
                )
            })?;
        }
        fs::rename(&source, &target).map_err(|_| {
            Self::make_api_error(
                ApiErrorCode::InternalError,
                "unable to move workspace file",
                false,
            )
        })?;
        Ok(WorkspaceFileInfo {
            path: request
                .target_path
                .clone()
                .unwrap_or_else(|| request.path.clone()),
            size: target
                .metadata()
                .map(|metadata| metadata.len())
                .unwrap_or(0) as u64,
            file_type: "file".to_string(),
        })
    }

    pub fn delete_workspace_file(
        &self,
        workspace_id: &str,
        access_token: &str,
        path: &str,
    ) -> Result<(), ApiError> {
        self.validate_workspace_access(workspace_id, access_token)?;
        let target = self.workspace_file_path(workspace_id, path)?;
        if !target.exists() || !target.is_file() {
            return Err(Self::make_api_error(
                ApiErrorCode::WorkspaceNotFound,
                "workspace file not found",
                false,
            ));
        }
        fs::remove_file(target).map_err(|_| {
            Self::make_api_error(
                ApiErrorCode::InternalError,
                "unable to delete workspace file",
                false,
            )
        })
    }

    pub fn run_code_in_workspace(
        &self,
        workspace_id: &str,
        access_token: &str,
        request: &CodeRunRequest,
    ) -> Result<CodeRunResult, ApiError> {
        self.validate_workspace_access(workspace_id, access_token)?;
        if !self.runtime_is_active(workspace_id) {
            return Err(Self::make_api_error(
                ApiErrorCode::InternalError,
                "workspace runtime is not running",
                true,
            ));
        }
        if request.code.len() > 3 * 1024 * 1024
            || request.stdin.as_deref().unwrap_or("").len() > 65_536
        {
            return Err(Self::make_api_error(
                ApiErrorCode::InvalidRequest,
                "code or input exceeds execution limits",
                false,
            ));
        }
        let profile = match request.language.to_lowercase().as_str() {
            "python" | "py" => ("main.py", "python3 main.py"),
            "javascript" | "js" | "node" | "nodejs" | "mjs" | "cjs" => ("main.js", "node main.js"),
            "typescript" | "ts" | "tsx" => ("main.ts", "tsx main.ts"),
            "bash" | "shell" => ("main.sh", "bash main.sh"),
            "java" => ("Main.java", "javac Main.java && java Main"),
            "c" => ("main.c", "gcc main.c -O2 -o main && ./main"),
            "cpp" | "cxx" | "cc" => ("main.cpp", "g++ main.cpp -O2 -o main && ./main"),
            "csharp" | "cs" => ("Program.cs", "dotnet new console --force --output app >/dev/null && cp Program.cs app/Program.cs && dotnet run --project app"),
            "kotlin" | "kt" | "kts" => ("Main.kt", "kotlinc Main.kt -include-runtime -d main.jar && java -jar main.jar"),
            "rust" | "rs" => ("main.rs", "rustc main.rs -O -o main && ./main"),
            "go" => ("main.go", "mkdir -p .go-tmp && TMPDIR=$PWD/.go-tmp go run main.go"),
            "php" => ("main.php", "php main.php"),
            "ruby" | "rb" => ("main.rb", "ruby main.rb"),
            _ => return Err(Self::make_api_error(ApiErrorCode::InvalidRequest, "unsupported runtime", false)),
        };
        let run_id = Uuid::new_v4().to_string();
        let host_source_path =
            std::env::temp_dir().join(format!("skcoder-run-{run_id}-{}", profile.0));
        let container_directory = format!("/tmp/skcoder-run-{run_id}");
        let container_source_path = format!("{container_directory}/{}", profile.0);
        fs::write(&host_source_path, request.code.as_bytes()).map_err(|_| {
            Self::make_api_error(
                ApiErrorCode::InternalError,
                "unable to write execution source",
                false,
            )
        })?;

        let setup = Command::new("docker")
            .args([
                "exec",
                "--workdir",
                "/workspace",
                &Self::container_name_for(workspace_id),
                "mkdir",
                "-p",
                &container_directory,
            ])
            .output();
        if let Err(error) = &setup {
            let _ = fs::remove_file(&host_source_path);
            return Err(Self::make_api_error(
                ApiErrorCode::InternalError,
                format!("docker setup failed: {error}"),
                true,
            ));
        }
        if !setup.as_ref().unwrap().status.success() {
            let _ = fs::remove_file(&host_source_path);
            return Err(Self::make_api_error(
                ApiErrorCode::InternalError,
                "docker setup failed",
                true,
            ));
        }

        let copy = Command::new("docker")
            .args([
                "cp",
                host_source_path.to_str().unwrap_or(""),
                &format!(
                    "{}:{}",
                    Self::container_name_for(workspace_id),
                    container_source_path
                ),
            ])
            .output();
        let _ = fs::remove_file(&host_source_path);
        if let Err(error) = &copy {
            return Err(Self::make_api_error(
                ApiErrorCode::InternalError,
                format!("docker source copy failed: {error}"),
                true,
            ));
        }
        if !copy.as_ref().unwrap().status.success() {
            return Err(Self::make_api_error(
                ApiErrorCode::InternalError,
                "docker source copy failed",
                true,
            ));
        }

        let command = "cd \"$1\"; timeout --signal=KILL 30s bash -c \"$2\" > >(head -c 250000) 2> >(head -c 250000 >&2); status=$?; wait; rm -rf \"$1\"; exit $status";
        let started = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let mut process = Command::new("docker")
            .args([
                "exec",
                "-i",
                "--workdir",
                "/workspace",
                &Self::container_name_for(workspace_id),
                "bash",
                "-lc",
                command,
                "skcoder-run",
                &container_directory,
                profile.1,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| {
                Self::make_api_error(ApiErrorCode::InternalError, "docker execution failed", true)
            })?;
        if let Some(mut stdin) = process.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(request.stdin.as_deref().unwrap_or("").as_bytes());
            let _ = stdin.flush();
            drop(stdin);
        }
        let output = process.wait_with_output().map_err(|_| {
            Self::make_api_error(ApiErrorCode::InternalError, "docker execution failed", true)
        })?;
        let elapsed = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64)
            .saturating_sub(started);
        Ok(CodeRunResult {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(1),
            execution_time_ms: elapsed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn app_state_round_trip_from_contracts() {
        let app = AppState::new();
        let request = CreateWorkspaceRequest {
            retention_seconds: Some(120),
        };
        let workspace = app.create_workspace(&request).unwrap();
        assert!(!workspace.access_token.is_empty());
        let summary = app.get_workspace(&workspace.workspace_id).unwrap();
        assert_eq!(summary.workspace_id, workspace.workspace_id);
    }

    #[test]
    fn workspace_file_paths_reject_traversal_and_symlinks() {
        let app = AppState::new();
        let created = app
            .create_workspace(&CreateWorkspaceRequest {
                retention_seconds: Some(120),
            })
            .unwrap();
        let root = AppState::workspace_root_for(&created.workspace_id);
        fs::create_dir_all(format!("{root}/safe")).unwrap();
        symlink(format!("{root}/safe"), format!("{root}/link")).unwrap();
        assert!(app
            .workspace_file_path(&created.workspace_id, "link/escaped.txt")
            .is_err());
        assert!(app
            .workspace_file_path(&created.workspace_id, "../outside")
            .is_err());
        assert!(app
            .workspace_file_path(&created.workspace_id, "/tmp/outside")
            .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_file_paths_allow_safe_nested_creation() {
        let app = AppState::new();
        let created = app
            .create_workspace(&CreateWorkspaceRequest {
                retention_seconds: Some(120),
            })
            .unwrap();
        let root = AppState::workspace_root_for(&created.workspace_id);
        fs::create_dir_all(&root).unwrap();
        let path = app
            .workspace_file_path(&created.workspace_id, "nested/dir/file.txt")
            .unwrap();
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("file.txt")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_capability_must_match_hash() {
        let app = AppState::new();
        let created = app
            .create_workspace(&CreateWorkspaceRequest {
                retention_seconds: Some(120),
            })
            .unwrap();
        let request = CreateOperationRequest {
            kind: sk_coder_contracts::OperationKind::Terminal,
            resources: sk_coder_contracts::ResourceRequest {
                cpu_millis: 100,
                memory_bytes: 512 * 1024 * 1024,
                pids: 32,
                scratch_bytes: 64 * 1024 * 1024,
                timeout_ms: 60_000,
                output_bytes: 50_000,
                reservation_bytes: 16 * 1024 * 1024,
            },
            idempotency_key: None,
            payload: None,
        };
        let result = app.create_operation(&created.workspace_id, "not-the-right-token", &request);
        assert!(matches!(
            result,
            Err(ApiError {
                code: ApiErrorCode::Unauthorized,
                ..
            })
        ));
    }

    #[test]
    fn operation_lookup_and_cancellation_work_with_workspace_access() {
        let app = AppState::new();
        let created = app
            .create_workspace(&CreateWorkspaceRequest {
                retention_seconds: Some(120),
            })
            .unwrap();
        let request = CreateOperationRequest {
            kind: sk_coder_contracts::OperationKind::CodeRun,
            resources: sk_coder_contracts::ResourceRequest {
                cpu_millis: 50,
                memory_bytes: 256 * 1024 * 1024,
                pids: 16,
                scratch_bytes: 32 * 1024 * 1024,
                timeout_ms: 30_000,
                output_bytes: 50_000,
                reservation_bytes: 8 * 1024 * 1024,
            },
            idempotency_key: None,
            payload: None,
        };
        let operation = app
            .create_operation(&created.workspace_id, &created.access_token, &request)
            .unwrap();
        let looked_up = app
            .get_operation(
                &created.workspace_id,
                &created.access_token,
                &operation.operation_id,
            )
            .unwrap();
        assert_eq!(looked_up.operation_id, operation.operation_id);
        let cancelled = app
            .cancel_operation(
                &created.workspace_id,
                &created.access_token,
                &operation.operation_id,
            )
            .unwrap();
        assert_eq!(cancelled.state, OperationState::Cancelled);
    }

    #[test]
    fn runtime_container_names_are_stable_and_active_probe_is_false_without_docker() {
        let app = AppState::new();
        let container = AppState::container_name_for("workspace-123");
        assert_eq!(container, "skcoder-workspace123");
        assert!(!app.runtime_is_active("workspace-123"));
    }

    #[test]
    fn command_execution_requires_runtime_and_non_empty_command() {
        let app = AppState::new();
        let created = app
            .create_workspace(&CreateWorkspaceRequest {
                retention_seconds: Some(120),
            })
            .unwrap();
        let empty = app.run_command_in_workspace(
            &created.workspace_id,
            &created.access_token,
            &TerminalCommandRequest {
                command: String::new(),
                cwd: None,
            },
        );
        assert!(matches!(
            empty,
            Err(ApiError {
                code: ApiErrorCode::InvalidRequest,
                ..
            })
        ));

        let missing_runtime = app.run_command_in_workspace(
            &created.workspace_id,
            &created.access_token,
            &TerminalCommandRequest {
                command: "pwd".to_string(),
                cwd: None,
            },
        );
        assert!(matches!(
            missing_runtime,
            Err(ApiError {
                code: ApiErrorCode::InternalError,
                ..
            })
        ));
    }
}
