use std::{sync::Arc, time::Duration};

use axum::http::Method;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::error::ApiError;

const WAIT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub struct RequestAdmission {
    auth: Lane,
    write: Lane,
    read: Lane,
    stale_read: Lane,
}

#[derive(Clone)]
struct Lane {
    active: Arc<Semaphore>,
    accepted: Arc<Semaphore>,
}

pub struct RequestPermit {
    _active: OwnedSemaphorePermit,
    _accepted: OwnedSemaphorePermit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RequestLane {
    Auth,
    Write,
    Read,
    StaleRead,
}

impl RequestAdmission {
    pub fn bounded_default() -> Self {
        Self {
            auth: Lane::new(2, 16),
            write: Lane::new(1, 16),
            read: Lane::new(4, 32),
            stale_read: Lane::new(1, 8),
        }
    }

    pub async fn acquire(&self, method: &Method, path: &str) -> Result<RequestPermit, ApiError> {
        self.lane(classify_request(method, path)).acquire().await
    }

    #[inline]
    fn lane(&self, lane: RequestLane) -> &Lane {
        match lane {
            RequestLane::Auth => &self.auth,
            RequestLane::Write => &self.write,
            RequestLane::Read => &self.read,
            RequestLane::StaleRead => &self.stale_read,
        }
    }
}

impl Lane {
    fn new(active: usize, accepted: usize) -> Self {
        Self {
            active: Arc::new(Semaphore::new(active)),
            accepted: Arc::new(Semaphore::new(accepted)),
        }
    }

    async fn acquire(&self) -> Result<RequestPermit, ApiError> {
        let accepted = self
            .accepted
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::Busy)?;
        let active = tokio::time::timeout(WAIT_TIMEOUT, self.active.clone().acquire_owned())
            .await
            .map_err(|_| ApiError::Busy)?
            .map_err(|_| ApiError::Internal)?;
        Ok(RequestPermit {
            _active: active,
            _accepted: accepted,
        })
    }
}

#[inline]
fn classify_request(method: &Method, path: &str) -> RequestLane {
    if path.starts_with("/api/auth/") {
        return RequestLane::Auth;
    }
    if method != Method::GET && method != Method::HEAD {
        return RequestLane::Write;
    }
    if path.ends_with("/result") || path == "/api/annotation/queue" {
        return RequestLane::StaleRead;
    }
    RequestLane::Read
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::http::Method;
    use tokio::sync::mpsc;

    use super::{Lane, RequestLane, classify_request};

    #[test]
    fn request_classes_are_stable() {
        assert_eq!(
            classify_request(&Method::POST, "/api/auth/local/login"),
            RequestLane::Auth
        );
        assert_eq!(
            classify_request(&Method::POST, "/api/coaching/sessions"),
            RequestLane::Write
        );
        assert_eq!(
            classify_request(&Method::GET, "/api/coaching/sessions/id"),
            RequestLane::Read
        );
        assert_eq!(
            classify_request(&Method::GET, "/api/coaching/sessions/id/result"),
            RequestLane::StaleRead
        );
    }

    #[tokio::test]
    async fn lane_releases_active_permits_in_waiter_order() {
        let lane = Arc::new(Lane::new(1, 3));
        let held = lane.acquire().await.unwrap();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let first_lane = lane.clone();
        let first_sender = sender.clone();
        let first = tokio::spawn(async move {
            let permit = first_lane.acquire().await.unwrap();
            first_sender.send(1).unwrap();
            permit
        });
        tokio::task::yield_now().await;
        let second_lane = lane.clone();
        let second = tokio::spawn(async move {
            let permit = second_lane.acquire().await.unwrap();
            sender.send(2).unwrap();
            permit
        });
        tokio::task::yield_now().await;
        drop(held);
        assert_eq!(receiver.recv().await, Some(1));
        drop(first.await.unwrap());
        assert_eq!(receiver.recv().await, Some(2));
        drop(second.await.unwrap());
    }

    #[tokio::test]
    async fn lane_rejects_requests_beyond_its_bounded_waiting_capacity() {
        let lane = Lane::new(1, 1);
        let _held = lane.acquire().await.unwrap();
        assert!(lane.acquire().await.is_err());
    }
}
