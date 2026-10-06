use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};

use sk_coder_contracts::{
    ApiError, ApiErrorCode, CodeRunRequest, CreateOperationRequest, CreateWorkspaceRequest,
    WorkspaceFileOperationRequest, WorkspaceFileRequest,
};
use sk_coder_server::{AppState, TerminalCommandRequest};

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/workspaces", post(create_workspace))
        .route(
            "/api/workspaces/:workspace_id",
            get(get_workspace).delete(delete_workspace),
        )
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
        .route(
            "/api/workspaces/:workspace_id/files",
            get(list_workspace_files)
                .post(write_workspace_file)
                .delete(delete_workspace_file),
        )
        .route(
            "/api/workspaces/:workspace_id/files/move",
            post(move_workspace_file),
        )
        .route(
            "/api/workspaces/:workspace_id/code/run",
            post(run_workspace_code),
        )
        .with_state(AppState::new());

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3030")
        .await
        .expect("bind to 0.0.0.0:3030");
    axum::serve(listener, app).await.expect("start axum server");
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

async fn list_workspace_files(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let token = workspace_access_header(&headers)?;
    match state.list_workspace_files(&workspace_id, &token) {
        Ok(files) => Ok((StatusCode::OK, Json(files))),
        Err(err) => Err(error_response(&err, status_for_code(&err.code))),
    }
}

async fn write_workspace_file(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<WorkspaceFileRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let token = workspace_access_header(&headers)?;
    match state.write_workspace_file(&workspace_id, &token, &request) {
        Ok(file) => Ok((StatusCode::CREATED, Json(file))),
        Err(err) => Err(error_response(&err, status_for_code(&err.code))),
    }
}

async fn move_workspace_file(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<WorkspaceFileOperationRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let token = workspace_access_header(&headers)?;
    match state.move_workspace_file(&workspace_id, &token, &request) {
        Ok(file) => Ok((StatusCode::OK, Json(file))),
        Err(err) => Err(error_response(&err, status_for_code(&err.code))),
    }
}

async fn delete_workspace_file(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let token = workspace_access_header(&headers)?;
    let path = query.get("path").map(String::as_str).unwrap_or("");
    match state.delete_workspace_file(&workspace_id, &token, path) {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(err) => Err(error_response(&err, status_for_code(&err.code))),
    }
}

async fn run_workspace_code(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<CodeRunRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let token = workspace_access_header(&headers)?;
    match state.run_code_in_workspace(&workspace_id, &token, &request) {
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
