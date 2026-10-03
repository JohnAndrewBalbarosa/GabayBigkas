pub mod audio;
pub mod auth;
pub mod comparison;
pub mod config;
pub mod error;
pub mod inference_bundle;
pub mod modal_inference;
pub mod model;
pub mod poc_access;
pub mod routes;
pub mod store;

use std::sync::Arc;

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
    pub poc_access: poc_access::PocAccess,
    pub store: Arc<Store>,
}
