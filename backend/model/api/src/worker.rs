use std::{process::Stdio, time::Duration};

use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};

use crate::protocol::{WorkerReady, WorkerRequest, WorkerResponse};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(300);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
const TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(300);

pub struct WorkerBridge {
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
    startup: WorkerReady,
}

impl WorkerBridge {
    // Mental model: start one long-lived model process, validate CUDA readiness,
    // then reuse its JSON Lines channel for health and transcription requests.
    pub async fn spawn(python: &str, script: &str) -> Result<Self, String> {
        let mut child = Command::new(python)
            .arg("-u")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("failed to start Python worker: {error}"))?;
        let input = child.stdin.take().ok_or("worker stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("worker stdout unavailable")?;
        let mut output = BufReader::new(stdout).lines();
        let ready_line = timeout(STARTUP_TIMEOUT, output.next_line())
            .await
            .map_err(|_| "worker model startup timed out")?
            .map_err(|error| format!("failed to read worker readiness: {error}"))?
            .ok_or("worker exited before readiness")?;
        let startup: WorkerReady = serde_json::from_str(&ready_line)
            .map_err(|error| format!("invalid worker readiness JSON: {error}"))?;
        validate_cuda_readiness(&startup)?;

        Ok(Self {
            child,
            input,
            output,
            startup,
        })
    }

    pub fn startup_summary(&self) -> (&str, &str, &str, &str) {
        (
            &self.startup.model,
            &self.startup.model_revision,
            &self.startup.device,
            &self.startup.gpu_name,
        )
    }

    pub async fn health(&mut self, request_id: &str) -> Result<WorkerResponse, String> {
        self.exchange(
            WorkerRequest {
                request_id,
                action: "health",
                audio_wav_base64: None,
            },
            HEALTH_TIMEOUT,
        )
        .await
    }

    pub async fn transcribe(
        &mut self,
        request_id: &str,
        audio_wav_base64: &str,
    ) -> Result<WorkerResponse, String> {
        self.exchange(
            WorkerRequest {
                request_id,
                action: "transcribe",
                audio_wav_base64: Some(audio_wav_base64),
            },
            TRANSCRIPTION_TIMEOUT,
        )
        .await
    }

    async fn exchange(
        &mut self,
        request: WorkerRequest<'_>,
        response_timeout: Duration,
    ) -> Result<WorkerResponse, String> {
        if let Some(status) = self
            .child
            .try_wait()
            .map_err(|error| format!("failed to inspect worker: {error}"))?
        {
            return Err(format!("worker already exited with {status}"));
        }

        let request_id = request.request_id.to_owned();
        let mut encoded = serde_json::to_vec(&request)
            .map_err(|error| format!("failed to encode worker request: {error}"))?;
        encoded.push(b'\n');
        self.input
            .write_all(&encoded)
            .await
            .map_err(|error| format!("failed to write worker request: {error}"))?;
        self.input
            .flush()
            .await
            .map_err(|error| format!("failed to flush worker request: {error}"))?;

        let response_line = timeout(response_timeout, self.output.next_line())
            .await
            .map_err(|_| "worker response timed out")?
            .map_err(|error| format!("failed to read worker response: {error}"))?
            .ok_or("worker exited without a response")?;
        let response: WorkerResponse = serde_json::from_str(&response_line)
            .map_err(|error| format!("invalid worker response JSON: {error}"))?;
        if response.request_id != request_id {
            return Err("worker response request_id mismatch".to_owned());
        }
        Ok(response)
    }
}

fn validate_cuda_readiness(ready: &WorkerReady) -> Result<(), String> {
    if ready.message_type != "ready" {
        return Err("worker did not send a ready message".to_owned());
    }
    if ready.accelerator != "cuda" || !ready.device.starts_with("cuda") {
        return Err(format!(
            "worker must use CUDA, reported accelerator={} device={}",
            ready.accelerator, ready.device
        ));
    }
    Ok(())
}
