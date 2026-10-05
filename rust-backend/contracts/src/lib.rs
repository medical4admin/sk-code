use serde::{Deserialize, Serialize};

pub const CONTRACT_SCHEMA_VERSION: u16 = 1;
pub const BASE_WORKSPACE_BYTES: u64 = 250 * 1024 * 1024;
pub const BURST_WORKSPACE_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceState {
    Active,
    ScheduledDelete,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    Suspended,
    Starting,
    Running,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    Terminal,
    CodeRun,
    DependencyInstall,
    Preview,
    Gui,
    ApkInspect,
    ApkDecode,
    ApkBuild,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Created,
    Queued,
    Starting,
    Running,
    Completing,
    Complete,
    Failed,
    Cancelled,
    Expired,
}

impl OperationState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Complete | Self::Failed | Self::Cancelled | Self::Expired
        )
    }

    pub fn may_transition_to(self, next: Self) -> bool {
        use OperationState::*;
        matches!(
            (self, next),
            (Created, Queued | Starting | Failed | Cancelled | Expired)
                | (Queued, Starting | Failed | Cancelled | Expired)
                | (Starting, Running | Failed | Cancelled | Expired)
                | (Running, Completing | Failed | Cancelled | Expired)
                | (Completing, Complete | Failed | Cancelled | Expired)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateWorkspaceRequest {
    pub retention_seconds: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceCreated {
    pub workspace_id: String,
    pub access_token: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub state: WorkspaceState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceRecord {
    pub schema_version: u16,
    pub workspace_id: String,
    pub access_token_sha256: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub state: WorkspaceState,
    pub runtime_state: RuntimeState,
    pub revision: u64,
    pub bytes_used: u64,
    pub base_quota_bytes: u64,
    pub burst_quota_bytes: u64,
    pub burst_expires_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub workspace_id: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub state: WorkspaceState,
    pub runtime_state: RuntimeState,
    pub revision: u64,
    pub bytes_used: u64,
    pub base_quota_bytes: u64,
    pub burst_quota_bytes: u64,
    pub burst_expires_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceRequest {
    pub cpu_millis: u32,
    pub memory_bytes: u64,
    pub pids: u32,
    pub scratch_bytes: u64,
    pub timeout_ms: u64,
    pub output_bytes: u64,
    pub reservation_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateOperationRequest {
    pub kind: OperationKind,
    pub resources: ResourceRequest,
    pub idempotency_key: Option<String>,
    pub payload: Option<std::collections::BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationRecord {
    pub schema_version: u16,
    pub operation_id: String,
    pub workspace_id: String,
    pub kind: OperationKind,
    pub state: OperationState,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub queue_sequence: Option<u64>,
    pub progress_percent: Option<u8>,
    pub resources: ResourceRequest,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl OperationRecord {
    pub fn transition(&mut self, next: OperationState, now_ms: u64) -> Result<(), TransitionError> {
        if now_ms < self.updated_at_ms {
            return Err(TransitionError::ClockMovedBackwards);
        }
        if !self.state.may_transition_to(next) {
            return Err(TransitionError::NotAllowed {
                from: self.state,
                to: next,
            });
        }
        self.state = next;
        self.updated_at_ms = now_ms;
        if next != OperationState::Queued {
            self.queue_sequence = None;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionError {
    ClockMovedBackwards,
    NotAllowed {
        from: OperationState,
        to: OperationState,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiErrorCode {
    InvalidRequest,
    WorkspaceNotFound,
    WorkspaceQuotaExceeded,
    SharedCapacityUnavailable,
    HostSafetyReserve,
    QueueFull,
    OperationConflict,
    Unauthorized,
    UnsupportedCapability,
    InternalError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiError {
    pub code: ApiErrorCode,
    pub message: String,
    pub retryable: bool,
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalLimits {
    pub workspace_base_bytes: u64,
    pub workspace_burst_bytes: u64,
    pub max_burst_seconds: u64,
    pub max_active_workspaces: u32,
    pub max_concurrent_operations: u32,
    pub max_queued_operations: u32,
    pub shared_pool_max_bytes: u64,
    pub shared_pool_admission_bytes: u64,
    pub safety_reserve_bytes: u64,
    pub max_total_cpu_millis: u32,
    pub max_total_memory_bytes: u64,
    pub max_total_pids: u32,
    pub max_operation_cpu_millis: u32,
    pub max_operation_memory_bytes: u64,
    pub max_operation_pids: u32,
    pub max_operation_scratch_bytes: u64,
    pub max_execution_ms: u64,
    pub max_output_bytes: u64,
}

impl GlobalLimits {
    pub fn validate(&self) -> Result<(), AdmissionError> {
        if self.workspace_base_bytes == 0
            || self.workspace_burst_bytes < self.workspace_base_bytes
            || self.max_burst_seconds == 0
            || self.max_active_workspaces == 0
            || self.max_concurrent_operations == 0
            || self.shared_pool_max_bytes == 0
            || self.shared_pool_admission_bytes == 0
            || self.shared_pool_admission_bytes >= self.shared_pool_max_bytes
            || self.safety_reserve_bytes == 0
            || self.max_total_cpu_millis == 0
            || self.max_total_memory_bytes == 0
            || self.max_total_pids == 0
            || self.max_operation_cpu_millis == 0
            || self.max_operation_memory_bytes == 0
            || self.max_operation_pids == 0
            || self.max_execution_ms == 0
            || self.max_output_bytes == 0
        {
            return Err(AdmissionError::InvalidLimits);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ResourceTotals {
    pub cpu_millis: u32,
    pub memory_bytes: u64,
    pub pids: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CapacitySnapshot {
    pub active_workspaces: u32,
    pub active_operations: u32,
    pub queued_operations: u32,
    pub reserved_shared_bytes: u64,
    pub filesystem_free_bytes: u64,
    pub active_resources: ResourceTotals,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionRequest {
    pub resources: ResourceRequest,
    pub needs_workspace_slot: bool,
    pub workspace_bytes_after: Option<u64>,
    pub burst_expires_at_ms: Option<u64>,
    pub now_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionError {
    InvalidLimits,
    InvalidResourceRequest,
    OperationResourceLimit,
    WorkspaceLimit,
    WorkspaceQuotaExceeded,
    InvalidBurstLease,
    SharedCapacityUnavailable,
    HostSafetyReserve,
    QueueFull,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionDecision {
    AdmitNow,
    Queue,
}

pub fn evaluate_admission(
    limits: &GlobalLimits,
    snapshot: &CapacitySnapshot,
    request: &AdmissionRequest,
) -> Result<AdmissionDecision, AdmissionError> {
    limits.validate()?;
    let resources = &request.resources;
    if resources.cpu_millis == 0
        || resources.memory_bytes == 0
        || resources.pids == 0
        || resources.timeout_ms == 0
        || resources.output_bytes == 0
    {
        return Err(AdmissionError::InvalidResourceRequest);
    }
    if resources.cpu_millis > limits.max_operation_cpu_millis
        || resources.memory_bytes > limits.max_operation_memory_bytes
        || resources.pids > limits.max_operation_pids
        || resources.scratch_bytes > limits.max_operation_scratch_bytes
        || resources.timeout_ms > limits.max_execution_ms
        || resources.output_bytes > limits.max_output_bytes
    {
        return Err(AdmissionError::OperationResourceLimit);
    }
    if request.needs_workspace_slot && snapshot.active_workspaces >= limits.max_active_workspaces {
        return Err(AdmissionError::WorkspaceLimit);
    }
    if let Some(bytes_after) = request.workspace_bytes_after {
        if bytes_after > limits.workspace_base_bytes {
            let burst_deadline = request
                .burst_expires_at_ms
                .ok_or(AdmissionError::WorkspaceQuotaExceeded)?;
            let max_deadline = request
                .now_ms
                .checked_add(limits.max_burst_seconds.saturating_mul(1000))
                .ok_or(AdmissionError::InvalidBurstLease)?;
            if bytes_after > limits.workspace_burst_bytes {
                return Err(AdmissionError::WorkspaceQuotaExceeded);
            }
            if burst_deadline <= request.now_ms || burst_deadline > max_deadline {
                return Err(AdmissionError::InvalidBurstLease);
            }
        }
    }
    let reserved_after = snapshot
        .reserved_shared_bytes
        .checked_add(resources.reservation_bytes)
        .ok_or(AdmissionError::SharedCapacityUnavailable)?;
    if reserved_after > limits.shared_pool_admission_bytes {
        return Err(AdmissionError::SharedCapacityUnavailable);
    }
    if snapshot
        .filesystem_free_bytes
        .saturating_sub(resources.reservation_bytes)
        < limits.safety_reserve_bytes
    {
        return Err(AdmissionError::HostSafetyReserve);
    }

    let totals_fit = snapshot
        .active_resources
        .cpu_millis
        .saturating_add(resources.cpu_millis)
        <= limits.max_total_cpu_millis
        && snapshot
            .active_resources
            .memory_bytes
            .saturating_add(resources.memory_bytes)
            <= limits.max_total_memory_bytes
        && snapshot
            .active_resources
            .pids
            .saturating_add(resources.pids)
            <= limits.max_total_pids;
    if snapshot.active_operations >= limits.max_concurrent_operations || !totals_fit {
        if snapshot.queued_operations >= limits.max_queued_operations {
            return Err(AdmissionError::QueueFull);
        }
        return Ok(AdmissionDecision::Queue);
    }
    Ok(AdmissionDecision::AdmitNow)
}

pub fn queue_position(records: &[OperationRecord], operation_id: &str) -> Option<u32> {
    let mut queued: Vec<&OperationRecord> = records
        .iter()
        .filter(|record| record.state == OperationState::Queued)
        .collect();
    queued.sort_by_key(|record| {
        (
            record.queue_sequence.unwrap_or(u64::MAX),
            record.created_at_ms,
            record.operation_id.as_str(),
        )
    });
    queued
        .iter()
        .position(|record| record.operation_id == operation_id)
        .map(|index| index as u32 + 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn limits() -> GlobalLimits {
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

    fn resources() -> ResourceRequest {
        ResourceRequest {
            cpu_millis: 500,
            memory_bytes: 512 * 1024 * 1024,
            pids: 128,
            scratch_bytes: 64 * 1024 * 1024,
            timeout_ms: 60_000,
            output_bytes: 500_000,
            reservation_bytes: 64 * 1024 * 1024,
        }
    }

    fn snapshot() -> CapacitySnapshot {
        CapacitySnapshot {
            active_workspaces: 1,
            active_operations: 0,
            queued_operations: 0,
            reserved_shared_bytes: 0,
            filesystem_free_bytes: 150 * 1024 * 1024 * 1024,
            active_resources: ResourceTotals::default(),
        }
    }

    fn operation(id: &str, state: OperationState, sequence: Option<u64>) -> OperationRecord {
        OperationRecord {
            schema_version: CONTRACT_SCHEMA_VERSION,
            operation_id: id.to_owned(),
            workspace_id: "workspace-1".to_owned(),
            kind: OperationKind::CodeRun,
            state,
            created_at_ms: 1,
            updated_at_ms: 1,
            queue_sequence: sequence,
            progress_percent: None,
            resources: resources(),
            error_code: None,
            error_message: None,
        }
    }

    #[test]
    fn openapi_declares_anonymous_creation_and_capability_protected_routes() {
        let api: Value = serde_json::from_str(include_str!("../openapi.json")).unwrap();
        assert_eq!(api["openapi"], "3.1.0");
        assert_eq!(
            api["paths"]["/workspaces"]["post"]["security"],
            serde_json::json!([])
        );
        assert_eq!(
            api["components"]["securitySchemes"]["WorkspaceAccess"]["name"],
            "X-SK-Workspace-Access"
        );
        assert!(api["paths"]
            .get("/workspaces/{workspace_id}/operations/{operation_id}")
            .is_some());
    }

    #[test]
    fn persistent_workspace_record_never_contains_plaintext_capability() {
        let record = WorkspaceRecord {
            schema_version: CONTRACT_SCHEMA_VERSION,
            workspace_id: "workspace-1".to_owned(),
            access_token_sha256: "a".repeat(64),
            created_at_ms: 1,
            expires_at_ms: 2,
            state: WorkspaceState::Active,
            runtime_state: RuntimeState::Suspended,
            revision: 0,
            bytes_used: 0,
            base_quota_bytes: BASE_WORKSPACE_BYTES,
            burst_quota_bytes: BURST_WORKSPACE_BYTES,
            burst_expires_at_ms: None,
        };
        let stored = serde_json::to_value(record).unwrap();
        assert!(stored.get("access_token").is_none());
        assert!(stored.get("access_token_sha256").is_some());
        let api: Value = serde_json::from_str(include_str!("../openapi.json")).unwrap();
        let schema = &api["components"]["schemas"]["WorkspaceRecord"]["properties"];
        assert!(schema.get("access_token_sha256").is_some());
        assert!(schema.get("access_token").is_none());
    }

    #[test]
    fn operation_transitions_allow_recovery_and_reject_terminal_mutation() {
        let mut record = operation("op-1", OperationState::Created, None);
        record.transition(OperationState::Queued, 2).unwrap();
        record.queue_sequence = Some(10);
        record.transition(OperationState::Starting, 3).unwrap();
        assert_eq!(record.queue_sequence, None);
        record.transition(OperationState::Running, 4).unwrap();
        record.transition(OperationState::Completing, 5).unwrap();
        record.transition(OperationState::Complete, 6).unwrap();
        assert!(record.state.is_terminal());
        assert!(record.transition(OperationState::Running, 7).is_err());
        assert_eq!(record.updated_at_ms, 6);
    }

    #[test]
    fn operation_transitions_reject_time_regression() {
        let mut record = operation("op-1", OperationState::Created, None);
        assert_eq!(
            record.transition(OperationState::Starting, 0),
            Err(TransitionError::ClockMovedBackwards)
        );
    }

    #[test]
    fn fifo_position_uses_durable_sequence_not_input_order() {
        let records = [
            operation("later", OperationState::Queued, Some(20)),
            operation("running", OperationState::Running, None),
            operation("first", OperationState::Queued, Some(10)),
        ];
        assert_eq!(queue_position(&records, "first"), Some(1));
        assert_eq!(queue_position(&records, "later"), Some(2));
        assert_eq!(queue_position(&records, "running"), None);
    }

    #[test]
    fn admission_is_global_and_has_no_user_identity_or_per_user_quota() {
        assert_eq!(
            evaluate_admission(
                &limits(),
                &snapshot(),
                &AdmissionRequest {
                    resources: resources(),
                    needs_workspace_slot: true,
                    workspace_bytes_after: Some(BASE_WORKSPACE_BYTES),
                    burst_expires_at_ms: None,
                    now_ms: 100,
                }
            ),
            Ok(AdmissionDecision::AdmitNow)
        );
    }

    #[test]
    fn base_quota_is_enforced_and_burst_must_be_explicit_and_temporary() {
        let mut request = AdmissionRequest {
            resources: resources(),
            needs_workspace_slot: false,
            workspace_bytes_after: Some(BASE_WORKSPACE_BYTES + 1),
            burst_expires_at_ms: None,
            now_ms: 100,
        };
        assert_eq!(
            evaluate_admission(&limits(), &snapshot(), &request),
            Err(AdmissionError::WorkspaceQuotaExceeded)
        );
        request.burst_expires_at_ms = Some(100 + 30 * 60 * 1000);
        assert_eq!(
            evaluate_admission(&limits(), &snapshot(), &request),
            Ok(AdmissionDecision::AdmitNow)
        );
        request.workspace_bytes_after = Some(BURST_WORKSPACE_BYTES + 1);
        assert_eq!(
            evaluate_admission(&limits(), &snapshot(), &request),
            Err(AdmissionError::WorkspaceQuotaExceeded)
        );
    }

    #[test]
    fn burst_expiration_cannot_be_missing_expired_or_unbounded() {
        let mut request = AdmissionRequest {
            resources: resources(),
            needs_workspace_slot: false,
            workspace_bytes_after: Some(BASE_WORKSPACE_BYTES + 1),
            burst_expires_at_ms: Some(99),
            now_ms: 100,
        };
        assert_eq!(
            evaluate_admission(&limits(), &snapshot(), &request),
            Err(AdmissionError::InvalidBurstLease)
        );
        request.burst_expires_at_ms = Some(100 + 3601 * 1000);
        assert_eq!(
            evaluate_admission(&limits(), &snapshot(), &request),
            Err(AdmissionError::InvalidBurstLease)
        );
    }

    #[test]
    fn shared_pool_and_host_safety_reserve_are_checked_before_admission() {
        let mut current = snapshot();
        current.reserved_shared_bytes = limits().shared_pool_admission_bytes;
        let request = AdmissionRequest {
            resources: resources(),
            needs_workspace_slot: false,
            workspace_bytes_after: None,
            burst_expires_at_ms: None,
            now_ms: 100,
        };
        assert_eq!(
            evaluate_admission(&limits(), &current, &request),
            Err(AdmissionError::SharedCapacityUnavailable)
        );
        current.reserved_shared_bytes = 0;
        current.filesystem_free_bytes =
            limits().safety_reserve_bytes + resources().reservation_bytes - 1;
        assert_eq!(
            evaluate_admission(&limits(), &current, &request),
            Err(AdmissionError::HostSafetyReserve)
        );
    }

    #[test]
    fn work_queues_when_busy_and_rejects_when_global_queue_is_full() {
        let mut current = snapshot();
        current.active_operations = limits().max_concurrent_operations;
        let request = AdmissionRequest {
            resources: resources(),
            needs_workspace_slot: false,
            workspace_bytes_after: None,
            burst_expires_at_ms: None,
            now_ms: 100,
        };
        assert_eq!(
            evaluate_admission(&limits(), &current, &request),
            Ok(AdmissionDecision::Queue)
        );
        current.queued_operations = limits().max_queued_operations;
        assert_eq!(
            evaluate_admission(&limits(), &current, &request),
            Err(AdmissionError::QueueFull)
        );
    }

    #[test]
    fn resource_hard_limits_and_active_workspace_cap_are_enforced() {
        let mut request = AdmissionRequest {
            resources: resources(),
            needs_workspace_slot: false,
            workspace_bytes_after: None,
            burst_expires_at_ms: None,
            now_ms: 100,
        };
        request.resources.memory_bytes = limits().max_operation_memory_bytes + 1;
        assert_eq!(
            evaluate_admission(&limits(), &snapshot(), &request),
            Err(AdmissionError::OperationResourceLimit)
        );
        request.resources = resources();
        request.needs_workspace_slot = true;
        let mut current = snapshot();
        current.active_workspaces = limits().max_active_workspaces;
        assert_eq!(
            evaluate_admission(&limits(), &current, &request),
            Err(AdmissionError::WorkspaceLimit)
        );
    }

    #[test]
    fn openapi_models_match_rust_serialized_field_names() {
        let api: Value = serde_json::from_str(include_str!("../openapi.json")).unwrap();
        let request = serde_json::to_value(CreateOperationRequest {
            kind: OperationKind::ApkInspect,
            resources: resources(),
            idempotency_key: None,
            payload: None,
        })
        .unwrap();
        let schema = &api["components"]["schemas"]["CreateOperationRequest"]["properties"];
        for key in request.as_object().unwrap().keys() {
            assert!(
                schema.get(key).is_some(),
                "OpenAPI is missing Rust field {key}"
            );
        }
        assert_eq!(request["kind"], "apk_inspect");
        assert_eq!(request["resources"]["cpu_millis"], 500);
    }
}
