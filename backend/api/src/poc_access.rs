use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::ApiError;

const TICKET_TTL_SECONDS: i64 = 2 * 60 * 60;

#[derive(Clone, Default)]
pub struct PocAccess {
    active: Arc<Mutex<Option<ActiveTicket>>>,
}

#[derive(Debug, PartialEq)]
enum TicketPhase {
    ReadyToExport,
    Exporting,
    ReadyToImport,
    Importing,
}

struct ActiveTicket {
    job_id: String,
    token_hash: String,
    expires_at: i64,
    phase: TicketPhase,
}

pub struct IssuedTicket {
    pub token: String,
    pub expires_at: i64,
}

impl PocAccess {
    pub fn issue(
        &self,
        job_id: &str,
        job_expires_at: i64,
        now: i64,
    ) -> Result<IssuedTicket, ApiError> {
        let mut active = self.lock()?;
        discard_expired_ticket(&mut active, now);
        if active.is_some() {
            return Err(ApiError::Conflict(
                "hintayin munang matapos o mag-expire ang active Colab POC job".to_owned(),
            ));
        }

        let expires_at = job_expires_at.min(now + TICKET_TTL_SECONDS);
        if expires_at <= now {
            return Err(ApiError::Invalid("inference job has expired".to_owned()));
        }
        let token = format!("poc_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        *active = Some(ActiveTicket {
            job_id: job_id.to_owned(),
            token_hash: hash_token(&token),
            expires_at,
            phase: TicketPhase::ReadyToExport,
        });
        Ok(IssuedTicket { token, expires_at })
    }

    pub fn begin_export(&self, job_id: &str, token: &str, now: i64) -> Result<(), ApiError> {
        self.transition(
            job_id,
            token,
            now,
            TicketPhase::ReadyToExport,
            TicketPhase::Exporting,
        )
    }

    pub fn finish_export(&self, job_id: &str, token: &str) -> Result<(), ApiError> {
        self.transition_without_expiry(
            job_id,
            token,
            TicketPhase::Exporting,
            TicketPhase::ReadyToImport,
        )
    }

    pub fn abort_export(&self, job_id: &str, token: &str) {
        let _ = self.transition_without_expiry(
            job_id,
            token,
            TicketPhase::Exporting,
            TicketPhase::ReadyToExport,
        );
    }

    pub fn begin_import(&self, job_id: &str, token: &str, now: i64) -> Result<(), ApiError> {
        self.transition(
            job_id,
            token,
            now,
            TicketPhase::ReadyToImport,
            TicketPhase::Importing,
        )
    }

    pub fn finish_import(&self, job_id: &str, token: &str) -> Result<(), ApiError> {
        let mut active = self.lock()?;
        require_ticket(&active, job_id, token)?;
        if active.as_ref().map(|ticket| &ticket.phase) != Some(&TicketPhase::Importing) {
            return Err(ApiError::Conflict(
                "Colab POC import is not active".to_owned(),
            ));
        }
        *active = None;
        Ok(())
    }

    pub fn abort_import(&self, job_id: &str, token: &str) {
        let _ = self.transition_without_expiry(
            job_id,
            token,
            TicketPhase::Importing,
            TicketPhase::ReadyToImport,
        );
    }

    fn transition(
        &self,
        job_id: &str,
        token: &str,
        now: i64,
        expected: TicketPhase,
        next: TicketPhase,
    ) -> Result<(), ApiError> {
        let mut active = self.lock()?;
        discard_expired_ticket(&mut active, now);
        transition_ticket(&mut active, job_id, token, expected, next)
    }

    fn transition_without_expiry(
        &self,
        job_id: &str,
        token: &str,
        expected: TicketPhase,
        next: TicketPhase,
    ) -> Result<(), ApiError> {
        let mut active = self.lock()?;
        transition_ticket(&mut active, job_id, token, expected, next)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<ActiveTicket>>, ApiError> {
        self.active.lock().map_err(|_| ApiError::Internal)
    }
}

fn transition_ticket(
    active: &mut Option<ActiveTicket>,
    job_id: &str,
    token: &str,
    expected: TicketPhase,
    next: TicketPhase,
) -> Result<(), ApiError> {
    require_ticket(active, job_id, token)?;
    let ticket = active.as_mut().ok_or(ApiError::Unauthorized)?;
    if ticket.phase != expected {
        return Err(ApiError::Conflict(
            "Colab POC job must run one export then one import".to_owned(),
        ));
    }
    ticket.phase = next;
    Ok(())
}

fn require_ticket(
    active: &Option<ActiveTicket>,
    job_id: &str,
    token: &str,
) -> Result<(), ApiError> {
    let ticket = active.as_ref().ok_or(ApiError::Unauthorized)?;
    if ticket.job_id != job_id || ticket.token_hash != hash_token(token) {
        return Err(ApiError::Unauthorized);
    }
    Ok(())
}

fn discard_expired_ticket(active: &mut Option<ActiveTicket>, now: i64) {
    if active
        .as_ref()
        .is_some_and(|ticket| ticket.expires_at <= now)
    {
        *active = None;
    }
}

fn hash_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::PocAccess;

    #[test]
    fn allows_exactly_one_export_then_one_import() {
        let access = PocAccess::default();
        let ticket = access.issue("job-1", 10_000, 100).unwrap();

        access.begin_export("job-1", &ticket.token, 100).unwrap();
        access.finish_export("job-1", &ticket.token).unwrap();
        access.begin_import("job-1", &ticket.token, 100).unwrap();
        access.finish_import("job-1", &ticket.token).unwrap();

        assert!(access.issue("job-2", 10_000, 100).is_ok());
    }

    #[test]
    fn rejects_parallel_ticket_and_wrong_job() {
        let access = PocAccess::default();
        let ticket = access.issue("job-1", 10_000, 100).unwrap();

        assert!(access.issue("job-2", 10_000, 100).is_err());
        assert!(access.begin_export("job-2", &ticket.token, 100).is_err());
        assert!(access.begin_export("job-1", "wrong", 100).is_err());
    }

    #[test]
    fn expired_ticket_releases_the_single_slot() {
        let access = PocAccess::default();
        let ticket = access.issue("job-1", 101, 100).unwrap();

        assert!(access.begin_export("job-1", &ticket.token, 101).is_err());
        assert!(access.issue("job-2", 10_000, 101).is_ok());
    }

    #[test]
    fn failed_steps_can_be_retried_only_manually() {
        let access = PocAccess::default();
        let ticket = access.issue("job-1", 10_000, 100).unwrap();

        access.begin_export("job-1", &ticket.token, 100).unwrap();
        access.abort_export("job-1", &ticket.token);
        access.begin_export("job-1", &ticket.token, 100).unwrap();
        access.finish_export("job-1", &ticket.token).unwrap();
        access.begin_import("job-1", &ticket.token, 100).unwrap();
        access.abort_import("job-1", &ticket.token);
        assert!(access.begin_import("job-1", &ticket.token, 100).is_ok());
    }
}
