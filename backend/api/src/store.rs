use std::{
    fs,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    auth::{Principal, hash_password},
    error::ApiError,
};

pub struct Store {
    connection: Mutex<Connection>,
}

#[derive(Clone, Debug)]
pub struct LocalUser {
    pub id: String,
    pub email: String,
    pub password_hash: String,
    pub role: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TranscriptEvent {
    pub sequence: i64,
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Clone, Debug)]
pub struct AudioChunk {
    pub sequence: i64,
    pub sample_rate: u32,
    pub channels: u16,
    pub path: String,
}

#[derive(Clone, Debug)]
pub struct CoachFeedbackRecord {
    pub agent_id: String,
    pub coach_message: String,
    pub youtube_title: String,
    pub youtube_video_id: String,
    pub youtube_url: String,
}

pub enum CoachFeedbackClaim {
    Generate,
    Idempotent(CoachFeedbackRecord),
}

#[derive(Clone, Debug, Serialize)]
pub struct CoachingSession {
    pub id: String,
    pub learner_id: String,
    pub exercise_id: String,
    pub expected_phrases: Vec<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inference_job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis_expires_at: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct InferenceJob {
    pub id: String,
    pub session_id: String,
    pub audio_path: String,
    pub audio_sha256: String,
    pub audio_bytes: usize,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_ms: i64,
    pub model_id: String,
    pub model_revision: String,
    pub status: String,
    pub result_sha256: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
}

pub enum ImportStart {
    Started(Box<InferenceJob>),
    Idempotent,
}

#[derive(Clone, Debug, Serialize)]
pub struct AnnotationItem {
    pub id: String,
    pub session_id: String,
    pub expected_text: String,
    pub agora_text: String,
    pub buzz_text: String,
    pub sentence_start_ms: i64,
    pub sentence_end_ms: i64,
    pub focus_start_ms: i64,
    pub focus_end_ms: i64,
    pub clip_key: String,
    pub status: String,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.execute_batch(SCHEMA)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn seed_local_user(&self, email: &str, password: &str, role: &str) -> Result<(), ApiError> {
        if !matches!(role, "learner" | "annotator") {
            return Err(ApiError::Invalid("unsupported role".to_owned()));
        }
        let password_hash = hash_password(password)?;
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .execute(
                "INSERT INTO users(id,email,password_hash,role,created_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(email) DO NOTHING",
                params![Uuid::new_v4().to_string(), email.to_ascii_lowercase(), password_hash, role, now()],
            )?;
        Ok(())
    }

    pub fn find_local_user(&self, email: &str) -> Result<Option<LocalUser>, ApiError> {
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .query_row(
                "SELECT id,email,password_hash,role FROM users WHERE email=?1",
                [email.to_ascii_lowercase()],
                |row| {
                    Ok(LocalUser {
                        id: row.get(0)?,
                        email: row.get(1)?,
                        password_hash: row.get(2)?,
                        role: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn create_auth_session(&self, user_id: &str, token_hash: &str) -> Result<(), ApiError> {
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .execute(
                "INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?1,?2,?3,?4)",
                params![token_hash, user_id, now() + 28_800, now()],
            )?;
        Ok(())
    }

    pub fn resolve_principal(&self, token_hash: &str) -> Result<Option<Principal>, ApiError> {
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .query_row(
                "SELECT u.id,u.email,u.role FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?1 AND s.revoked_at IS NULL AND s.expires_at>?2",
                params![token_hash, now()],
                |row| Ok(Principal { user_id: row.get(0)?, email: row.get(1)?, role: row.get(2)? }),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn revoke_auth_session(&self, token_hash: &str) -> Result<(), ApiError> {
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .execute(
                "UPDATE auth_sessions SET revoked_at=?2 WHERE token_hash=?1",
                params![token_hash, now()],
            )?;
        Ok(())
    }

    pub fn create_coaching_session(
        &self,
        learner_id: &str,
        exercise_id: &str,
        expected_phrases: &[String],
        adult_consent: bool,
    ) -> Result<CoachingSession, ApiError> {
        let id = Uuid::new_v4().to_string();
        let expected_json =
            serde_json::to_string(expected_phrases).map_err(|_| ApiError::Internal)?;
        let mut connection = self.connection.lock().map_err(|_| ApiError::Internal)?;
        let transaction = connection.transaction()?;
        transaction.execute(
                "INSERT INTO coaching_sessions(id,learner_id,exercise_id,expected_json,status,created_at) VALUES(?1,?2,?3,?4,'capturing',?5)",
                params![id, learner_id, exercise_id, expected_json, now()],
            )?;
        transaction.execute(
            "INSERT INTO session_consents(session_id,adult_consent,recorded_at) VALUES(?1,?2,?3)",
            params![id, adult_consent, now()],
        )?;
        transaction.commit()?;
        Ok(CoachingSession {
            id,
            learner_id: learner_id.to_owned(),
            exercise_id: exercise_id.to_owned(),
            expected_phrases: expected_phrases.to_vec(),
            status: "capturing".to_owned(),
            inference_job_id: None,
            analysis_expires_at: None,
        })
    }

    pub fn coaching_session(&self, id: &str) -> Result<Option<CoachingSession>, ApiError> {
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .query_row(
                "SELECT s.id,s.learner_id,s.exercise_id,s.expected_json,s.status,j.id,j.expires_at FROM coaching_sessions s LEFT JOIN inference_jobs j ON j.session_id=s.id WHERE s.id=?1",
                [id],
                |row| {
                    let expected_json: String = row.get(3)?;
                    Ok(CoachingSession {
                        id: row.get(0)?,
                        learner_id: row.get(1)?,
                        exercise_id: row.get(2)?,
                        expected_phrases: serde_json::from_str(&expected_json).unwrap_or_default(),
                        status: row.get(4)?,
                        inference_job_id: row.get(5)?,
                        analysis_expires_at: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn set_coaching_status(&self, id: &str, status: &str) -> Result<(), ApiError> {
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .execute(
                "UPDATE coaching_sessions SET status=?2,updated_at=?3 WHERE id=?1",
                params![id, status, now()],
            )?;
        Ok(())
    }

    pub fn session_has_adult_consent(&self, session_id: &str) -> Result<bool, ApiError> {
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .query_row(
                "SELECT adult_consent FROM session_consents WHERE session_id=?1",
                [session_id],
                |row| row.get::<_, bool>(0),
            )
            .optional()
            .map(|value| value.unwrap_or(false))
            .map_err(Into::into)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_inference_job(
        &self,
        session_id: &str,
        audio_path: &str,
        audio_sha256: &str,
        audio_bytes: usize,
        sample_rate: u32,
        channels: u16,
        duration_ms: i64,
        model_id: &str,
        model_revision: &str,
    ) -> Result<InferenceJob, ApiError> {
        let id = Uuid::new_v4().to_string();
        let created_at = now();
        let expires_at = created_at + 86_400;
        let mut connection = self.connection.lock().map_err(|_| ApiError::Internal)?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO inference_jobs(id,session_id,audio_path,audio_sha256,audio_bytes,sample_rate,channels,duration_ms,model_id,model_revision,status,created_at,expires_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending_manual_inference',?11,?12,?11)",
            params![id,session_id,audio_path,audio_sha256,audio_bytes as i64,sample_rate,channels,duration_ms,model_id,model_revision,created_at,expires_at],
        )?;
        transaction.execute(
            "UPDATE coaching_sessions SET status='pending_manual_inference',updated_at=?2 WHERE id=?1",
            params![session_id, created_at],
        )?;
        transaction.commit()?;
        Ok(InferenceJob {
            id,
            session_id: session_id.to_owned(),
            audio_path: audio_path.to_owned(),
            audio_sha256: audio_sha256.to_owned(),
            audio_bytes,
            sample_rate,
            channels,
            duration_ms,
            model_id: model_id.to_owned(),
            model_revision: model_revision.to_owned(),
            status: "pending_manual_inference".to_owned(),
            result_sha256: None,
            created_at,
            expires_at,
        })
    }

    pub fn inference_job(&self, id: &str) -> Result<Option<InferenceJob>, ApiError> {
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .query_row(
                "SELECT id,session_id,audio_path,audio_sha256,audio_bytes,sample_rate,channels,duration_ms,model_id,model_revision,status,result_sha256,created_at,expires_at FROM inference_jobs WHERE id=?1",
                [id],
                read_inference_job,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn pending_inference_jobs(&self) -> Result<Vec<InferenceJob>, ApiError> {
        let connection = self.connection.lock().map_err(|_| ApiError::Internal)?;
        let mut statement = connection.prepare(
            "SELECT id,session_id,audio_path,audio_sha256,audio_bytes,sample_rate,channels,duration_ms,model_id,model_revision,status,result_sha256,created_at,expires_at FROM inference_jobs WHERE status IN ('pending_manual_inference','exported','importing') AND expires_at>?1 ORDER BY created_at",
        )?;
        statement
            .query_map([now()], read_inference_job)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn mark_inference_job_exported(&self, id: &str) -> Result<(), ApiError> {
        self.connection.lock().map_err(|_| ApiError::Internal)?.execute(
            "UPDATE inference_jobs SET status=CASE WHEN status='pending_manual_inference' THEN 'exported' ELSE status END,updated_at=?2 WHERE id=?1 AND expires_at>?2",
            params![id, now()],
        )?;
        Ok(())
    }

    pub fn claim_inference_job_for_modal(&self, id: &str) -> Result<InferenceJob, ApiError> {
        let current = now();
        let mut connection = self.connection.lock().map_err(|_| ApiError::Internal)?;
        let transaction = connection.transaction()?;
        let job = transaction
            .query_row(
                "SELECT id,session_id,audio_path,audio_sha256,audio_bytes,sample_rate,channels,duration_ms,model_id,model_revision,status,result_sha256,created_at,expires_at FROM inference_jobs WHERE id=?1",
                [id],
                read_inference_job,
            )
            .optional()?
            .ok_or(ApiError::NotFound)?;
        if job.expires_at <= current {
            return Err(ApiError::Invalid("inference job has expired".to_owned()));
        }
        if !matches!(job.status.as_str(), "pending_manual_inference" | "exported") {
            return Err(ApiError::Conflict(
                "inference job is already running or completed".to_owned(),
            ));
        }
        transaction.execute(
            "DELETE FROM modal_inference_claims WHERE claimed_at<?1",
            [current - 900],
        )?;
        let claimed = transaction.execute(
            "INSERT OR IGNORE INTO modal_inference_claims(job_id,claimed_at) VALUES(?1,?2)",
            params![id, current],
        )?;
        if claimed != 1 {
            return Err(ApiError::Conflict(
                "inference job already has an active Modal execution".to_owned(),
            ));
        }
        transaction.commit()?;
        Ok(job)
    }

    pub fn release_modal_inference_claim(&self, id: &str) -> Result<(), ApiError> {
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .execute("DELETE FROM modal_inference_claims WHERE job_id=?1", [id])?;
        Ok(())
    }

    pub fn mark_inference_analysis_unavailable(&self, id: &str) -> Result<(), ApiError> {
        let mut connection = self.connection.lock().map_err(|_| ApiError::Internal)?;
        let transaction = connection.transaction()?;
        let session_id = transaction
            .query_row(
                "SELECT session_id FROM inference_jobs WHERE id=?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or(ApiError::NotFound)?;
        transaction.execute(
            "UPDATE inference_jobs SET status='analysis_unavailable',updated_at=?2 WHERE id=?1 AND status!='completed'",
            params![id, now()],
        )?;
        transaction.execute(
            "UPDATE coaching_sessions SET status='analysis_unavailable',updated_at=?2 WHERE id=?1",
            params![session_id, now()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn begin_inference_import(
        &self,
        id: &str,
        result_sha256: &str,
    ) -> Result<ImportStart, ApiError> {
        let current = now();
        let mut connection = self.connection.lock().map_err(|_| ApiError::Internal)?;
        let transaction = connection.transaction()?;
        let job = transaction.query_row(
            "SELECT id,session_id,audio_path,audio_sha256,audio_bytes,sample_rate,channels,duration_ms,model_id,model_revision,status,result_sha256,created_at,expires_at FROM inference_jobs WHERE id=?1",
            [id],
            read_inference_job,
        ).optional()?.ok_or(ApiError::NotFound)?;
        if job.expires_at <= current {
            return Err(ApiError::Invalid("inference job has expired".to_owned()));
        }
        if job.status == "completed" {
            return if job.result_sha256.as_deref() == Some(result_sha256) {
                Ok(ImportStart::Idempotent)
            } else {
                Err(ApiError::Conflict(
                    "a different result was already imported".to_owned(),
                ))
            };
        }
        if job.status == "importing" {
            return if job.result_sha256.as_deref() == Some(result_sha256) {
                Err(ApiError::Conflict(
                    "this result import is already in progress".to_owned(),
                ))
            } else {
                Err(ApiError::Conflict(
                    "a different result import is in progress".to_owned(),
                ))
            };
        }
        transaction.execute(
            "UPDATE inference_jobs SET status='importing',result_sha256=?2,updated_at=?3 WHERE id=?1",
            params![id, result_sha256, current],
        )?;
        transaction.commit()?;
        Ok(ImportStart::Started(Box::new(job)))
    }

    pub fn abort_inference_import(&self, id: &str, result_sha256: &str) -> Result<(), ApiError> {
        self.connection.lock().map_err(|_| ApiError::Internal)?.execute(
            "UPDATE inference_jobs SET status='exported',result_sha256=NULL,updated_at=?3 WHERE id=?1 AND status='importing' AND result_sha256=?2",
            params![id, result_sha256, now()],
        )?;
        Ok(())
    }

    pub fn complete_inference_import(
        &self,
        id: &str,
        result_sha256: &str,
        items: &[AnnotationItem],
    ) -> Result<(), ApiError> {
        let current = now();
        let mut connection = self.connection.lock().map_err(|_| ApiError::Internal)?;
        let transaction = connection.transaction()?;
        let session_id: String = transaction.query_row(
            "SELECT session_id FROM inference_jobs WHERE id=?1 AND status='importing' AND result_sha256=?2",
            params![id, result_sha256],
            |row| row.get(0),
        ).optional()?.ok_or_else(|| ApiError::Conflict("inference import state changed".to_owned()))?;
        for item in items {
            transaction.execute(
                "INSERT OR IGNORE INTO annotation_items(id,session_id,expected_text,agora_text,buzz_text,sentence_start_ms,sentence_end_ms,focus_start_ms,focus_end_ms,clip_key,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![item.id,item.session_id,item.expected_text,item.agora_text,item.buzz_text,item.sentence_start_ms,item.sentence_end_ms,item.focus_start_ms,item.focus_end_ms,item.clip_key,item.status,current],
            )?;
        }
        transaction.execute(
            "UPDATE inference_jobs SET status='completed',updated_at=?2 WHERE id=?1",
            params![id, current],
        )?;
        transaction.execute(
            "UPDATE coaching_sessions SET status='review_ready',updated_at=?2 WHERE id=?1",
            params![session_id, current],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn expire_inference_jobs(&self) -> Result<Vec<String>, ApiError> {
        let current = now();
        let mut connection = self.connection.lock().map_err(|_| ApiError::Internal)?;
        let transaction = connection.transaction()?;
        let mut statement = transaction.prepare(
            "SELECT audio_path,session_id FROM inference_jobs WHERE expires_at<=?1 AND status IN ('pending_manual_inference','exported','importing')",
        )?;
        let expired = statement
            .query_map([current], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for (_, session_id) in &expired {
            transaction.execute("UPDATE coaching_sessions SET status='analysis_unavailable',updated_at=?2 WHERE id=?1", params![session_id,current])?;
        }
        transaction.execute("UPDATE inference_jobs SET status='analysis_unavailable',updated_at=?1 WHERE expires_at<=?1 AND status IN ('pending_manual_inference','exported','importing')", [current])?;
        transaction.commit()?;
        Ok(expired.into_iter().map(|(path, _)| path).collect())
    }

    pub fn add_audio_chunk(&self, session_id: &str, chunk: &AudioChunk) -> Result<bool, ApiError> {
        let connection = self.connection.lock().map_err(|_| ApiError::Internal)?;
        let existing = connection
            .query_row(
                "SELECT sample_rate,channels,path FROM audio_chunks WHERE session_id=?1 AND sequence=?2",
                params![session_id, chunk.sequence],
                |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u16>(1)?, row.get::<_, String>(2)?)),
            )
            .optional()?;
        if let Some((sample_rate, channels, path)) = existing {
            if sample_rate == chunk.sample_rate && channels == chunk.channels && path == chunk.path
            {
                return Ok(true);
            }
            return Err(ApiError::Conflict(
                "audio sequence already contains different data".to_owned(),
            ));
        }
        connection.execute(
            "INSERT INTO audio_chunks(session_id,sequence,sample_rate,channels,path,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![session_id, chunk.sequence, chunk.sample_rate, chunk.channels, chunk.path, now()],
        )?;
        Ok(false)
    }

    pub fn claim_coach_feedback(
        &self,
        session_id: &str,
        agent_id: &str,
    ) -> Result<CoachFeedbackClaim, ApiError> {
        let mut connection = self.connection.lock().map_err(|_| ApiError::Internal)?;
        let transaction = connection.transaction()?;
        let existing = transaction
            .query_row(
                "SELECT agent_id,status,coach_message,youtube_title,youtube_video_id,youtube_url FROM coach_feedback WHERE session_id=?1",
                [session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()?;
        if let Some((stored_agent, status, message, title, video_id, url)) = existing {
            if stored_agent != agent_id {
                return Err(ApiError::Conflict(
                    "session is already linked to a different Agora agent".to_owned(),
                ));
            }
            if status == "completed" {
                return Ok(CoachFeedbackClaim::Idempotent(CoachFeedbackRecord {
                    agent_id: stored_agent,
                    coach_message: message.ok_or(ApiError::Internal)?,
                    youtube_title: title.ok_or(ApiError::Internal)?,
                    youtube_video_id: video_id.ok_or(ApiError::Internal)?,
                    youtube_url: url.ok_or(ApiError::Internal)?,
                }));
            }
            return Err(ApiError::Conflict(
                "coach feedback generation is already in progress".to_owned(),
            ));
        }
        transaction.execute(
            "INSERT INTO coach_feedback(session_id,agent_id,status,created_at,updated_at) VALUES(?1,?2,'pending',?3,?3)",
            params![session_id, agent_id, now()],
        )?;
        transaction.commit()?;
        Ok(CoachFeedbackClaim::Generate)
    }

    pub fn complete_coach_feedback(
        &self,
        session_id: &str,
        agent_id: &str,
        coach_message: &str,
        youtube_title: &str,
        youtube_video_id: &str,
        youtube_url: &str,
    ) -> Result<CoachFeedbackRecord, ApiError> {
        let rows = self.connection.lock().map_err(|_| ApiError::Internal)?.execute(
            "UPDATE coach_feedback SET status='completed',coach_message=?3,youtube_title=?4,youtube_video_id=?5,youtube_url=?6,updated_at=?7 WHERE session_id=?1 AND agent_id=?2 AND status='pending'",
            params![session_id, agent_id, coach_message, youtube_title, youtube_video_id, youtube_url, now()],
        )?;
        if rows != 1 {
            return Err(ApiError::Conflict(
                "coach feedback state changed".to_owned(),
            ));
        }
        Ok(CoachFeedbackRecord {
            agent_id: agent_id.to_owned(),
            coach_message: coach_message.to_owned(),
            youtube_title: youtube_title.to_owned(),
            youtube_video_id: youtube_video_id.to_owned(),
            youtube_url: youtube_url.to_owned(),
        })
    }

    pub fn release_coach_feedback_claim(
        &self,
        session_id: &str,
        agent_id: &str,
    ) -> Result<(), ApiError> {
        self.connection.lock().map_err(|_| ApiError::Internal)?.execute(
            "DELETE FROM coach_feedback WHERE session_id=?1 AND agent_id=?2 AND status='pending'",
            params![session_id, agent_id],
        )?;
        Ok(())
    }

    pub fn audio_chunks(&self, session_id: &str) -> Result<Vec<AudioChunk>, ApiError> {
        let connection = self.connection.lock().map_err(|_| ApiError::Internal)?;
        let mut statement = connection.prepare(
            "SELECT sequence,sample_rate,channels,path FROM audio_chunks WHERE session_id=?1 ORDER BY sequence",
        )?;
        let rows = statement.query_map([session_id], |row| {
            Ok(AudioChunk {
                sequence: row.get(0)?,
                sample_rate: row.get(1)?,
                channels: row.get(2)?,
                path: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn add_transcript_event(
        &self,
        session_id: &str,
        event: &TranscriptEvent,
    ) -> Result<(), ApiError> {
        if event.text.len() > 4_000 || event.start_ms < 0 || event.end_ms <= event.start_ms {
            return Err(ApiError::Invalid("invalid transcript event".to_owned()));
        }
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .execute(
                "INSERT INTO transcript_events(session_id,sequence,text,start_ms,end_ms,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
                params![session_id, event.sequence, event.text, event.start_ms, event.end_ms, now()],
            )?;
        Ok(())
    }

    pub fn transcript_events(&self, session_id: &str) -> Result<Vec<TranscriptEvent>, ApiError> {
        let connection = self.connection.lock().map_err(|_| ApiError::Internal)?;
        let mut statement = connection.prepare(
            "SELECT sequence,text,start_ms,end_ms FROM transcript_events WHERE session_id=?1 ORDER BY sequence",
        )?;
        let rows = statement.query_map([session_id], |row| {
            Ok(TranscriptEvent {
                sequence: row.get(0)?,
                text: row.get(1)?,
                start_ms: row.get(2)?,
                end_ms: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn add_annotation_item(&self, item: &AnnotationItem) -> Result<(), ApiError> {
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .execute(
                "INSERT INTO annotation_items(id,session_id,expected_text,agora_text,buzz_text,sentence_start_ms,sentence_end_ms,focus_start_ms,focus_end_ms,clip_key,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![item.id,item.session_id,item.expected_text,item.agora_text,item.buzz_text,item.sentence_start_ms,item.sentence_end_ms,item.focus_start_ms,item.focus_end_ms,item.clip_key,item.status,now()],
            )?;
        Ok(())
    }

    pub fn annotation_items(&self) -> Result<Vec<AnnotationItem>, ApiError> {
        let connection = self.connection.lock().map_err(|_| ApiError::Internal)?;
        let mut statement = connection.prepare(
            "SELECT id,session_id,expected_text,agora_text,buzz_text,sentence_start_ms,sentence_end_ms,focus_start_ms,focus_end_ms,clip_key,status FROM annotation_items WHERE status='pending' ORDER BY created_at",
        )?;
        collect_annotation_items(statement.query_map([], read_annotation_item)?)
    }

    pub fn annotation_item(&self, id: &str) -> Result<Option<AnnotationItem>, ApiError> {
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .query_row(
                "SELECT id,session_id,expected_text,agora_text,buzz_text,sentence_start_ms,sentence_end_ms,focus_start_ms,focus_end_ms,clip_key,status FROM annotation_items WHERE id=?1",
                [id],
                read_annotation_item,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn decide_annotation(
        &self,
        id: &str,
        annotator_id: &str,
        decision: &str,
        corrected_text: Option<&str>,
        notes: Option<&str>,
    ) -> Result<(), ApiError> {
        let changed = self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .execute(
                "UPDATE annotation_items SET status='reviewed',decision=?2,corrected_text=?3,notes=?4,annotator_id=?5,reviewed_at=?6 WHERE id=?1 AND status='pending'",
                params![id,decision,corrected_text,notes,annotator_id,now()],
            )?;
        if changed == 0 {
            return Err(ApiError::Conflict(
                "annotation item is already reviewed or missing".to_owned(),
            ));
        }
        Ok(())
    }
}

fn collect_annotation_items(
    rows: rusqlite::MappedRows<
        '_,
        impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<AnnotationItem>,
    >,
) -> Result<Vec<AnnotationItem>, ApiError> {
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn read_annotation_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<AnnotationItem> {
    Ok(AnnotationItem {
        id: row.get(0)?,
        session_id: row.get(1)?,
        expected_text: row.get(2)?,
        agora_text: row.get(3)?,
        buzz_text: row.get(4)?,
        sentence_start_ms: row.get(5)?,
        sentence_end_ms: row.get(6)?,
        focus_start_ms: row.get(7)?,
        focus_end_ms: row.get(8)?,
        clip_key: row.get(9)?,
        status: row.get(10)?,
    })
}

fn read_inference_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<InferenceJob> {
    Ok(InferenceJob {
        id: row.get(0)?,
        session_id: row.get(1)?,
        audio_path: row.get(2)?,
        audio_sha256: row.get(3)?,
        audio_bytes: row.get::<_, i64>(4)? as usize,
        sample_rate: row.get::<_, i64>(5)? as u32,
        channels: row.get::<_, i64>(6)? as u16,
        duration_ms: row.get(7)?,
        model_id: row.get(8)?,
        model_revision: row.get(9)?,
        status: row.get(10)?,
        result_sha256: row.get(11)?,
        created_at: row.get(12)?,
        expires_at: row.get(13)?,
    })
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

const SCHEMA: &str = r#"
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('learner','annotator')),created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL,revoked_at INTEGER,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS coaching_sessions(id TEXT PRIMARY KEY,learner_id TEXT NOT NULL REFERENCES users(id),exercise_id TEXT NOT NULL,expected_json TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER);
CREATE TABLE IF NOT EXISTS session_consents(session_id TEXT PRIMARY KEY REFERENCES coaching_sessions(id),adult_consent INTEGER NOT NULL CHECK(adult_consent IN (0,1)),recorded_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audio_chunks(session_id TEXT NOT NULL REFERENCES coaching_sessions(id),sequence INTEGER NOT NULL,sample_rate INTEGER NOT NULL,channels INTEGER NOT NULL,path TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(session_id,sequence));
CREATE TABLE IF NOT EXISTS transcript_events(session_id TEXT NOT NULL REFERENCES coaching_sessions(id),sequence INTEGER NOT NULL,text TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(session_id,sequence));
CREATE TABLE IF NOT EXISTS inference_jobs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES coaching_sessions(id),audio_path TEXT NOT NULL,audio_sha256 TEXT NOT NULL,audio_bytes INTEGER NOT NULL,sample_rate INTEGER NOT NULL,channels INTEGER NOT NULL,duration_ms INTEGER NOT NULL,model_id TEXT NOT NULL,model_revision TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending_manual_inference','exported','importing','completed','analysis_unavailable')),result_sha256 TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS inference_jobs_status_expiry_idx ON inference_jobs(status,expires_at);
CREATE TABLE IF NOT EXISTS modal_inference_claims(job_id TEXT PRIMARY KEY REFERENCES inference_jobs(id) ON DELETE CASCADE,claimed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS coach_feedback(session_id TEXT PRIMARY KEY REFERENCES coaching_sessions(id),agent_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','completed')),coach_message TEXT,youtube_title TEXT,youtube_video_id TEXT,youtube_url TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS annotation_items(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES coaching_sessions(id),expected_text TEXT NOT NULL,agora_text TEXT NOT NULL,buzz_text TEXT NOT NULL,sentence_start_ms INTEGER NOT NULL,sentence_end_ms INTEGER NOT NULL,focus_start_ms INTEGER NOT NULL,focus_end_ms INTEGER NOT NULL,clip_key TEXT NOT NULL,status TEXT NOT NULL,decision TEXT,corrected_text TEXT,notes TEXT,annotator_id TEXT REFERENCES users(id),reviewed_at INTEGER,created_at INTEGER NOT NULL);
"#;

#[cfg(test)]
mod tests {
    use super::Store;
    use crate::error::ApiError;

    #[test]
    fn modal_claim_allows_only_one_active_execution() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("coach.sqlite3")).unwrap();
        store
            .seed_local_user("learner@example.test", "password12345", "learner")
            .unwrap();
        let learner = store
            .find_local_user("learner@example.test")
            .unwrap()
            .unwrap();
        let session = store
            .create_coaching_session(&learner.id, "exercise", &["Prompt".to_owned()], true)
            .unwrap();
        let job = store
            .create_inference_job(
                &session.id,
                "audio.wav",
                &"a".repeat(64),
                100,
                16_000,
                1,
                1_000,
                "BuzzASR/filipino",
                "revision",
            )
            .unwrap();

        assert!(store.claim_inference_job_for_modal(&job.id).is_ok());
        assert!(matches!(
            store.claim_inference_job_for_modal(&job.id),
            Err(ApiError::Conflict(_))
        ));
        store.release_modal_inference_claim(&job.id).unwrap();
        assert!(store.claim_inference_job_for_modal(&job.id).is_ok());
    }

    #[test]
    fn audio_chunk_insertion_is_idempotent() {
        use super::AudioChunk;

        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("coach.sqlite3")).unwrap();
        store
            .seed_local_user("learner@example.test", "password12345", "learner")
            .unwrap();
        let learner = store
            .find_local_user("learner@example.test")
            .unwrap()
            .unwrap();
        let session = store
            .create_coaching_session(&learner.id, "exercise", &["Prompt".to_owned()], true)
            .unwrap();

        let chunk = AudioChunk {
            sequence: 0,
            sample_rate: 16_000,
            channels: 1,
            path: "chunk_0.pcm".to_owned(),
        };

        // First insert: not duplicate (idempotent = false)
        let first = store.add_audio_chunk(&session.id, &chunk).unwrap();
        assert!(!first);

        // Second insert with same sequence: idempotent duplicate (idempotent = true)
        let second = store.add_audio_chunk(&session.id, &chunk).unwrap();
        assert!(second);

        let chunks = store.audio_chunks(&session.id).unwrap();
        assert_eq!(chunks.len(), 1);
    }
}
