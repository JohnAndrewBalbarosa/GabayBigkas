pub mod agora_agent;
pub mod agora_tokens;
pub mod audio;
pub mod auth;
pub mod coach_feedback;
pub mod coach_routes;
pub mod coach_session;
pub mod comparison;
pub mod config;
pub mod error;
pub mod inference_bundle;
pub mod inference_workflow;
pub mod modal_inference;
pub mod model;
pub mod routes;
pub mod store;

#[cfg(test)]
mod mvp_tests;

use std::sync::Arc;

use coach_feedback::CoachFeedbackService;
use config::Config;
use inference_bundle::InferenceBundleService;
use modal_inference::ModalInferenceClient;
use store::Store;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub login_limiter: auth::LoginLimiter,
    pub inference_bundles: InferenceBundleService,
    pub modal_inference: Option<ModalInferenceClient>,
    pub coach_feedback: Option<CoachFeedbackService>,
    pub agora_agent: Option<agora_agent::AgoraAgentClient>,
    pub admission: Arc<tokio::sync::Semaphore>,
    pub background: Arc<tokio::sync::Semaphore>,
    pub store: Arc<Store>,
}
