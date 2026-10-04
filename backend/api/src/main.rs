use std::{env, sync::Arc};

use agora_coach_api::{
    AppState,
    agora_agent::AgoraAgentClient,
    auth::LoginLimiter,
    coach_feedback::CoachFeedbackService,
    config::Config,
    inference_bundle::{InferenceBundleService, run_expired_job_cleanup},
    modal_inference::ModalInferenceClient,
    routes,
    store::Store,
};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let config = Config::from_env();
    let store = Arc::new(Store::open(&config.database_path)?);
    seed_configured_accounts(&store)?;
    let inference_bundles = InferenceBundleService::new(config.private_audio_root.clone());
    let interrupted_paths = store.recover_interrupted_work()?;
    for path in &interrupted_paths {
        inference_bundles.cleanup_audio(path);
    }
    tracing::info!(
        event = "coach.recovery.completed",
        interrupted_jobs = interrupted_paths.len()
    );
    let modal_inference = ModalInferenceClient::from_config(&config)
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    let coach_feedback = CoachFeedbackService::from_config(&config)
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    let state = AppState {
        login_limiter: LoginLimiter::default(),
        inference_bundles: inference_bundles.clone(),
        modal_inference,
        coach_feedback,
        agora_agent: AgoraAgentClient::from_config(&config).map_err(std::io::Error::other)?,
        admission: Arc::new(tokio::sync::Semaphore::new(8)),
        background: Arc::new(tokio::sync::Semaphore::new(2)),
        store: store.clone(),
        config: config.clone(),
    };
    tokio::spawn(run_expired_job_cleanup(store.clone(), inference_bundles));
    let listener = TcpListener::bind(&config.bind).await?;
    tracing::info!(event = "coach.api.ready", bind = %config.bind);
    axum::serve(listener, routes::router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
            }
            Err(error) => {
                tracing::error!(event = "coach.shutdown_signal.failed", error = %error);
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!(event = "coach.shutdown.requested");
}

fn seed_configured_accounts(store: &Store) -> Result<(), Box<dyn std::error::Error>> {
    for (role, email_key, password_key) in [
        ("learner", "COACH_LEARNER_EMAIL", "COACH_LEARNER_PASSWORD"),
        (
            "annotator",
            "COACH_ANNOTATOR_EMAIL",
            "COACH_ANNOTATOR_PASSWORD",
        ),
    ] {
        if let (Ok(email), Ok(password)) = (env::var(email_key), env::var(password_key)) {
            store.seed_local_user(&email, &password, role)?;
        }
    }
    Ok(())
}
