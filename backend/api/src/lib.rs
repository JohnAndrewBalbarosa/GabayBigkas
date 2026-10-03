pub mod audio;
pub mod auth;
pub mod comparison;
pub mod config;
pub mod error;
pub mod inference_bundle;
pub mod model;
pub mod poc_access;
pub mod routes;
pub mod store;

use std::sync::Arc;

use config::Config;
use inference_bundle::InferenceBundleService;
use store::Store;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub login_limiter: auth::LoginLimiter,
    pub inference_bundles: InferenceBundleService,
    pub poc_access: poc_access::PocAccess,
    pub store: Arc<Store>,
}
