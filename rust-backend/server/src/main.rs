use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};

use sk_coder_contracts::{
    ApiError, ApiErrorCode, CreateOperationRequest, CreateWorkspaceRequest,
};
use sk_coder_server::{AppState, TerminalCommandRequest};

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/workspaces", post(create_workspace))
        .route("/api/workspaces/:workspace_id", get(get_workspace).delete(delete_workspace))
        .route(
            "/api/workspaces/:workspace_id/operations",
            post(create_operation),
        )
        .route(
            "/api/workspaces/:workspace_id/operations/:operation_id",
            get(get_operation).delete(cancel_operation),
        )
        .route(
            "/api/workspaces/:workspace_id/terminal/exec",
            post(exec_workspace_command),
        )
        .with_state(AppState::new());

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3030")
        .await
        .expect("bind to 0.0.0.0:3030");
    axum::serve(listener, app)
        .await
        .expect("start axum server");
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

async fn create_workspace(
    State(state): State<AppState>,
    Json(request): Json<CreateWorkspaceRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    match state.create_workspace(&request) {
        Ok(workspace) => Ok((StatusCode::CREATED, Json(workspace))),
        Err(err) => Err(error_response(&err, StatusCode::TOO_MANY_REQUESTS)),
    }
}

async fn get_workspace(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let token = workspace_access_header(&headers)?;
    match state.validate_workspace_access(&workspace_id, &token) {
        Ok(_) => match state.get_workspace(&workspace_id) {
            Ok(workspace) => Ok((StatusCode::OK, Json(workspace))),
            Err(err) => Err(error_response(&err, status_for_code(&err.code))),
        },
        Err(err) => Err(error_response(&err, status_for_code(&err.code))),
    }
}

async fn delete_workspace(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let token = workspace_access_header(&headers)?;
    match state.delete_workspace(&workspace_id, &token) {
        Ok(workspace) => Ok((StatusCode::ACCEPTED, Json(workspace))),
        Err(err) => Err(error_response(&err, status_for_code(&err.code))),
    }
}

async fn create_operation(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<CreateOperationRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let token = workspace_access_header(&headers)?;
    match state.create_operation(&workspace_id, &token, &request) {
        Ok(op) => Ok((StatusCode::ACCEPTED, Json(op))),
        Err(err) => Err(error_response(&err, status_for_code(&err.code))),
    }
}

async fn get_operation(
    State(state): State<AppState>,
    Path((workspace_id, operation_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let token = workspace_access_header(&headers)?;
    match state.get_operation(&workspace_id, &token, &operation_id) {
        Ok(operation) => Ok((StatusCode::OK, Json(operation))),
        Err(err) => Err(error_response(&err, status_for_code(&err.code))),
    }
}

async fn cancel_operation(
    State(state): State<AppState>,
    Path((workspace_id, operation_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let token = workspace_access_header(&headers)?;
    match state.cancel_operation(&workspace_id, &token, &operation_id) {
        Ok(operation) => Ok((StatusCode::ACCEPTED, Json(operation))),
        Err(err) => Err(error_response(&err, status_for_code(&err.code))),
    }
}

async fn exec_workspace_command(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<TerminalCommandRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let token = workspace_access_header(&headers)?;
    match state.run_command_in_workspace(&workspace_id, &token, &request) {
        Ok(result) => Ok((StatusCode::OK, Json(result))),
        Err(err) => Err(error_response(&err, status_for_code(&err.code))),
    }
}

fn workspace_access_header(headers: &HeaderMap) -> Result<String, (StatusCode, Json<ApiError>)> {
    let token = headers
        .get("x-sk-workspace-access")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(ApiError {
                    code: ApiErrorCode::Unauthorized,
                    message: "missing X-SK-Workspace-Access header".to_string(),
                    retryable: false,
                    details: None,
                }),
            )
        })?;
    Ok(token)
}

fn status_for_code(code: &ApiErrorCode) -> StatusCode {
    match code {
        ApiErrorCode::InvalidRequest => StatusCode::BAD_REQUEST,
        ApiErrorCode::WorkspaceNotFound => StatusCode::NOT_FOUND,
        ApiErrorCode::WorkspaceQuotaExceeded => StatusCode::TOO_MANY_REQUESTS,
        ApiErrorCode::SharedCapacityUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        ApiErrorCode::HostSafetyReserve => StatusCode::SERVICE_UNAVAILABLE,
        ApiErrorCode::QueueFull => StatusCode::TOO_MANY_REQUESTS,
        ApiErrorCode::OperationConflict => StatusCode::CONFLICT,
        ApiErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
        ApiErrorCode::UnsupportedCapability => StatusCode::NOT_IMPLEMENTED,
        ApiErrorCode::InternalError => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn error_response(err: &ApiError, status: StatusCode) -> (StatusCode, Json<ApiError>) {
    (status, Json(err.clone()))
}
