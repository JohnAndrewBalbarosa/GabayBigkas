//! Backend HTTP integration: real auth, SQLite, files, asynchronous finalize and private review.
use std::{
    io::{Cursor, Read},
    sync::Arc,
    time::Duration,
};

use axum::{Json, Router, routing::post};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};

use crate::{
    AppState, auth::LoginLimiter, config::Config, inference_bundle::InferenceBundleService,
    modal_inference::ModalInferenceClient, request_admission::RequestAdmission, store::Store,
};

#[tokio::test]
async fn backend_mvp_http_flow_acknowledges_before_inference_and_keeps_results_private() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = Config::for_test();
    config.private_audio_root = directory.path().join("audio");
    config.allowed_origin = Some("https://frontend.example.test".to_owned());
    let store = Arc::new(Store::open(&directory.path().join("coach.sqlite3")).unwrap());
    store
        .seed_local_user("learner@example.test", "password12345", "learner")
        .unwrap();
    store
        .seed_local_user("other@example.test", "password12345", "learner")
        .unwrap();
    store
        .seed_local_user("reviewer@example.test", "password12345", "annotator")
        .unwrap();
    let gate = Arc::new(tokio::sync::Notify::new());
    let inference_gate = gate.clone();
    let modal = Router::new().route("/", post(move |Json(body): Json<Value>| {
        let gate = inference_gate.clone();
        async move {
            gate.notified().await;
            let zip = STANDARD.decode(body["bundle_zip_base64"].as_str().unwrap()).unwrap();
            let mut zip = zip::ZipArchive::new(Cursor::new(zip)).unwrap();
            let mut manifest = String::new();
            zip.by_name("manifest.json").unwrap().read_to_string(&mut manifest).unwrap();
            let manifest: Value = serde_json::from_str(&manifest).unwrap();
            Json(json!({
                "schema_version":1, "job_id":manifest["job_id"], "audio_sha256":manifest["audio_sha256"],
                "model_id":manifest["model_id"], "model_revision":manifest["model_revision"],
                "generated_at":crate::store::unix_now(), "text":"Fifty people think clearly.",
                "segments":[{"text":"Fifty people think clearly.","start_ms":0,"end_ms":900}],
                "words":[{"text":"Fifty","start_ms":0,"end_ms":200}]
            }))
        }
    }));
    let (modal_url, modal_task) = serve(modal).await;
    let state = AppState {
        inference_bundles: InferenceBundleService::new(config.private_audio_root.clone()),
        config,
        login_limiter: LoginLimiter::default(),
        modal_inference: Some(ModalInferenceClient::for_test(modal_url)),
        coach_feedback: None,
        agora_agent: None,
        request_admission: RequestAdmission::bounded_default(),
        inference_ready: Arc::new(tokio::sync::Notify::new()),
        store: store.clone(),
    };
    let inference_task = tokio::spawn(crate::inference_workflow::run_inference_queue(
        state.clone(),
    ));
    let (api, api_task) = serve(crate::routes::router(state)).await;
    let client = Client::new();
    let unauth = client
        .get(format!("{api}/api/annotation/queue"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);
    let learner = login(&client, &api, "learner@example.test").await;
    let other_learner = login(&client, &api, "other@example.test").await;
    let created = client.post(format!("{api}/api/coaching/sessions"))
        .header("origin", "https://frontend.example.test").header("cookie", &learner)
        .json(&json!({"exercise_id":"guided","expected_phrases":["Fifty people think clearly."],"recording_consent":true,"adult_consent":true}))
        .send().await.unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let session: Value = created.json().await.unwrap();
    let id = session["id"].as_str().unwrap();
    let video_url = format!("{api}/api/coaching/sessions/{id}/practice-video");
    assert_eq!(
        client
            .post(&video_url)
            .header("origin", "https://frontend.example.test")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post(&video_url)
            .header("origin", "https://frontend.example.test")
            .header("cookie", &other_learner)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        client
            .post(&video_url)
            .header("origin", "https://frontend.example.test")
            .header("cookie", &learner)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    let pcm: Vec<u8> = (0..16_000)
        .flat_map(|i| ((i % 200) as i16 * 30 - 3000).to_le_bytes())
        .collect();
    for duplicate in [false, true] {
        let response = chunk(&client, &api, id, &learner, pcm.clone()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let ack: Value = response.json().await.unwrap();
        assert_eq!(ack["accepted"], true);
        assert_eq!(ack["idempotent"], duplicate);
    }
    assert_eq!(
        chunk(&client, &api, id, &learner, vec![0; 32_000])
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let final_url = format!("{api}/api/coaching/sessions/{id}/finalize");
    let ack = tokio::time::timeout(
        Duration::from_secs(2),
        client
            .post(&final_url)
            .header("origin", "https://frontend.example.test")
            .header("cookie", &learner)
            .send(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(ack.status(), StatusCode::OK);
    let ack: Value = ack.json().await.unwrap();
    assert_eq!(ack["acknowledged"], true);
    assert_eq!(ack["status"], "queued");
    let repeated: Value = client
        .post(&final_url)
        .header("origin", "https://frontend.example.test")
        .header("cookie", &learner)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(repeated["idempotent"], true);
    gate.notify_one();
    let result_url = format!("{api}/api/coaching/sessions/{id}/result");
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let result: Value = client
                .get(&result_url)
                .header("cookie", &learner)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if result["status"] == "review_ready" {
                break result;
            }
            assert_ne!(result["status"], "analysis_unavailable", "{result}");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        result["transcription"]["text"],
        "Fifty people think clearly."
    );
    assert!(result["coach_feedback"].is_null());
    assert_eq!(result["practice_words"].as_array().unwrap().len(), 1);
    assert_eq!(
        client
            .post(&video_url)
            .header("origin", "https://frontend.example.test")
            .header("cookie", &learner)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(result["audio_items"].as_array().unwrap().len(), 1);
    store.reserve_coach_agent(id).unwrap();
    store
        .set_coach_agent_status(id, Some("owned-agent"), "running")
        .unwrap();
    let feedback_url = format!("{api}/api/coaching/sessions/{id}/coach-feedback");
    assert_eq!(
        client
            .post(&feedback_url)
            .header("origin", "https://frontend.example.test")
            .header("cookie", &learner)
            .json(&json!({"agent_id":"someone-elses-agent"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    store.claim_coach_feedback(id, "owned-agent").unwrap();
    store
        .complete_coach_feedback(
            id,
            "owned-agent",
            "Practice slowly.",
            "Practice video",
            "dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        )
        .unwrap();
    let cached: Value = client
        .post(&feedback_url)
        .header("origin", "https://frontend.example.test")
        .header("cookie", &learner)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(cached["idempotent"], true);
    assert_eq!(cached["coach_message"], "Practice slowly.");
    assert_eq!(cached["youtube_resources"][0]["video_id"], "dQw4w9WgXcQ");
    assert!(
        !directory
            .path()
            .join("audio")
            .join(id)
            .join("chunks")
            .exists()
    );
    assert!(
        !directory
            .path()
            .join("audio")
            .join(id)
            .join("processed.wav")
            .exists()
    );
    let item_id = result["audio_items"][0]["id"].as_str().unwrap();
    let audio_url = format!("{api}/api/annotation/items/{item_id}/audio");
    assert_eq!(
        client.get(&audio_url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let audio = client
        .get(&audio_url)
        .header("cookie", &learner)
        .send()
        .await
        .unwrap();
    assert_eq!(audio.status(), StatusCode::OK);
    assert_eq!(&audio.bytes().await.unwrap()[..4], b"RIFF");
    let decision_url = format!("{api}/api/annotation/items/{item_id}/decision");
    let decision = json!({"decision":"confirmed_transcript","corrected_text":null,"notes":""});
    assert_eq!(
        client
            .post(&decision_url)
            .header("origin", "https://frontend.example.test")
            .header("cookie", &learner)
            .json(&decision)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let reviewer = login(&client, &api, "reviewer@example.test").await;
    assert!(
        client
            .post(&decision_url)
            .header("origin", "https://frontend.example.test")
            .header("cookie", &reviewer)
            .json(&decision)
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    api_task.abort();
    inference_task.abort();
    modal_task.abort();
}

async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    (
        url,
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() }),
    )
}

async fn login(client: &Client, api: &str, email: &str) -> String {
    let response = client
        .post(format!("{api}/api/auth/local/login"))
        .header("origin", "https://frontend.example.test")
        .json(&json!({"email":email,"password":"password12345"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

async fn chunk(
    client: &Client,
    api: &str,
    id: &str,
    cookie: &str,
    pcm: Vec<u8>,
) -> reqwest::Response {
    client
        .post(format!("{api}/api/coaching/sessions/{id}/audio/chunks"))
        .header("origin", "https://frontend.example.test")
        .header("cookie", cookie)
        .header("x-audio-sequence", "0")
        .header("x-sample-rate", "16000")
        .header("x-channels", "1")
        .body(pcm)
        .send()
        .await
        .unwrap()
}
