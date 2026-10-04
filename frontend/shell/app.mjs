import { CoachApi } from '../transport/coach-api.mjs';
import { LearnerSession, renderSessionStatus } from '../learner/session.mjs';
import {
  renderLearnerFeedback,
  renderLearnerFeedbackError,
  renderLearnerFeedbackLoading,
} from '../learner/feedback.mjs';
import { LearnerCoachHandoff } from '../learner/coach-handoff.mjs';
import { renderAnnotationQueue } from '../annotator/review.mjs';

const RESULT_POLL_INTERVAL_MS = 2_000;
const RESULT_POLL_ATTEMPTS = 45;
const FEEDBACK_RETRY_INTERVAL_MS = 1_500;
const FEEDBACK_ATTEMPTS = 4;

const api = new CoachApi(globalThis.GABAYBIGKAS_API_BASE_URL ?? '');
const state = {
  account: null,
  coachingSessionId: null,
  coachFlow: null,
  coachHandoff: null,
  learnerStage: 'consent',
  flowEpoch: 0,
};
const learnerStatus = document.querySelector('#learner-status');
const learner = new LearnerSession(api, message => setLearnerStatus(message));

initializePage();

function initializePage() {
  renderLearnerFeedback(document, null);
  bindNavigation();
  bindAuthentication();
  bindLearnerSession();
  bindAnnotatorQueue();
  bindMobileMenu();
  bindHeroActions();
  renderLearnerStage('consent');
  void restoreAccountSession();
}

function bindNavigation() {
  document.querySelectorAll('[data-public-page]').forEach(control => {
    control.addEventListener('click', event => {
      event.preventDefault();
      showPublicPage(control.dataset.publicPage);
      closeMobileMenu();
    });
  });
  document.querySelectorAll('[data-workspace]').forEach(control => {
    control.addEventListener('click', () => {
      void showWorkspace(control.dataset.workspace);
      closeMobileMenu();
    });
  });
}

function bindHeroActions() {
  document.querySelector('#hero-cta-start').addEventListener('click', () => {
    if (state.account) void showWorkspace(state.account.role);
    else showPublicPage('login');
  });
  document.querySelector('#hero-cta-about').addEventListener('click', () => showPublicPage('about'));
}

function bindMobileMenu() {
  const toggle = document.querySelector('#menu-toggle');
  const nav = document.querySelector('#primary-nav');
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    nav.classList.toggle('is-open', open);
  });
}

function closeMobileMenu() {
  const toggle = document.querySelector('#menu-toggle');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Open navigation');
  document.querySelector('#primary-nav').classList.remove('is-open');
}

function bindAuthentication() {
  const form = document.querySelector('#login-form');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const input = new FormData(form);
    const status = document.querySelector('#login-status');
    const submit = form.querySelector('[type="submit"]');
    status.textContent = 'Checking your account…';
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    try {
      activateAccount(await api.login(input.get('email'), input.get('password')));
      form.reset();
      status.textContent = '';
    } catch (error) {
      status.textContent = userMessage(error);
    } finally {
      submit.disabled = false;
      form.setAttribute('aria-busy', 'false');
    }
  });

  document.querySelector('#logout').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    state.flowEpoch += 1;
    try {
      try {
        await learner.cancel();
      } catch {
        setLearnerStatus('The microphone stopped, but a pending audio upload was not completed.', true);
      }
      try {
        await stopCoachFlow();
      } catch (error) {
        setPageStatus(`Coach cleanup needs attention: ${userMessage(error)}`, true);
      }
      await api.logout();
      clearAccount('You are now signed out.');
    } catch (error) {
      setPageStatus(userMessage(error), true);
    } finally {
      event.currentTarget.disabled = false;
    }
  });
}

async function restoreAccountSession() {
  try {
    activateAccount(await api.session(), false);
  } catch {
    clearAccount('', false);
  }
}

function activateAccount(account, announce = true) {
  state.account = account;
  document.querySelector('#account').hidden = false;
  document.querySelector('#account-profile').textContent = account.email;
  document.querySelector('#account-role').textContent = account.role;
  document.querySelector('#workspace-navigation').hidden = false;
  document.querySelectorAll('[data-workspace]').forEach(control => {
    control.hidden = control.dataset.workspace !== account.role;
  });
  document.querySelectorAll('[data-public-page="login"], [data-public-page="signup"]').forEach(control => {
    control.hidden = true;
  });
  document.querySelector('#hero-cta-start').textContent = account.role === 'annotator' ? 'Open review queue' : 'Continue practice';
  if (announce) setPageStatus('Secure account session active.');
  void showWorkspace(account.role);
}

function clearAccount(message, announce = true) {
  state.flowEpoch += 1;
  state.account = null;
  state.coachingSessionId = null;
  document.querySelector('#account').hidden = true;
  document.querySelector('#workspace-navigation').hidden = true;
  document.querySelectorAll('[data-public-page="login"], [data-public-page="signup"]').forEach(control => {
    control.hidden = false;
  });
  document.querySelector('#hero-cta-start').textContent = 'Start practice';
  hideWorkspaces();
  showPublicPage('home');
  if (announce && message) setPageStatus(message);
}

function showPublicPage(page) {
  if (state.account && (page === 'login' || page === 'signup')) {
    void showWorkspace(state.account.role);
    return;
  }
  for (const id of ['home', 'about', 'login', 'signup']) document.querySelector(`#${id}`).hidden = id !== page;
  hideWorkspaces();
  document.querySelectorAll('[data-public-page]').forEach(control => {
    control.classList.toggle('is-active', control.dataset.publicPage === page);
  });
  document.querySelector('#main-content').focus({ preventScroll: true });
}

async function showWorkspace(role) {
  if (!state.account || state.account.role !== role) {
    setPageStatus('This account is not authorized for that workspace.', true);
    return;
  }
  for (const id of ['home', 'about', 'login', 'signup']) document.querySelector(`#${id}`).hidden = true;
  document.querySelectorAll('[data-public-page]').forEach(control => control.classList.remove('is-active'));
  document.querySelector('#learner').hidden = role !== 'learner';
  document.querySelector('#annotator').hidden = role !== 'annotator';
  document.querySelectorAll('[data-workspace]').forEach(control => {
    control.classList.toggle('is-active', control.dataset.workspace === role);
  });
  if (role === 'annotator') await refreshAnnotatorWorkspace();
}

function hideWorkspaces() {
  document.querySelector('#learner').hidden = true;
  document.querySelector('#annotator').hidden = true;
}

function bindLearnerSession() {
  const start = document.querySelector('#start-session');
  const finish = document.querySelector('#finish-session');
  const refresh = document.querySelector('#refresh-session');
  const consent = document.querySelector('#adult-consent');

  consent.addEventListener('change', () => {
    if (!learner.active) setLearnerStatus(consent.checked ? 'Ready. Start recording when you are prepared.' : 'Check consent when you are ready to begin.');
  });

  start.addEventListener('click', async () => {
    start.disabled = true;
    renderLearnerFeedback(document, null);
    setLearnerStatus('Requesting microphone access…');
    try {
      const result = await learner.start({
        exerciseId: 'ph-constitution-preamble-1987',
        expectedPhrases: guidedPassagePhrases(),
        adultConsent: consent.checked,
      });
      state.coachingSessionId = result.session.id;
      finish.disabled = false;
      consent.disabled = true;
      start.classList.add('is-recording');
      renderLearnerStage('record');
    } catch (error) {
      start.disabled = false;
      setLearnerStatus(userMessage(error), true);
    }
  });

  finish.addEventListener('click', async () => {
    finish.disabled = true;
    start.classList.remove('is-recording');
    renderLearnerStage('process');
    try {
      const result = await learner.finish();
      state.coachingSessionId = result.session_id;
      refresh.hidden = false;
      renderBackendSession(result);
      await continueLearnerFlow();
    } catch (error) {
      setLearnerStatus(userMessage(error), true);
    } finally {
      start.disabled = false;
      consent.disabled = false;
    }
  });

  refresh.addEventListener('click', async () => {
    if (!state.coachingSessionId) return;
    refresh.disabled = true;
    setLearnerStatus('Checking the latest backend status…');
    try {
      await continueLearnerFlow();
    } catch (error) {
      setLearnerStatus(userMessage(error), true);
    } finally {
      refresh.disabled = false;
    }
  });
}

function continueLearnerFlow() {
  if (state.coachFlow) return state.coachFlow;
  state.coachFlow = runLearnerFlow().finally(() => {
    state.coachFlow = null;
  });
  return state.coachFlow;
}

// Mental model: wait for private transcription, hand the bounded evidence to the
// session-owned agent, persist its response, then render one practice plan.
async function runLearnerFlow() {
  const sessionId = state.coachingSessionId;
  const flowEpoch = state.flowEpoch;
  if (!sessionId) return;
  renderLearnerFeedbackLoading(
    document,
    'Analyzing your reading…',
    'The private transcription usually finishes within a minute. You can see each stage here.',
  );
  document.querySelector('#feedback-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const result = await waitForProcessedResult(sessionId);
    if (flowEpoch !== state.flowEpoch) return;
    renderBackendSession(result);
    if (result.coach_feedback) {
      renderLearnerFeedback(document, result.coach_feedback);
      return;
    }
    if (result.status !== 'review_ready') {
      throw new Error(renderSessionStatus(result.status));
    }

    renderLearnerFeedbackLoading(
      document,
      'Preparing your AI practice guide…',
      'The transcript is ready. A private, session-owned coach is connecting now.',
    );
    const health = await api.health();
    if (flowEpoch !== state.flowEpoch) return;
    if (!health.agora_agent || !health.coach_feedback) {
      throw new Error('AI coaching is not configured on this server. An administrator must set the Agora and YouTube production credentials.');
    }
    const credentials = await api.startCoachAgent(sessionId);
    if (flowEpoch !== state.flowEpoch) {
      await api.stopCoachAgent(sessionId);
      return;
    }
    state.coachHandoff = new LearnerCoachHandoff((message) => {
      renderLearnerFeedbackLoading(document, 'Preparing your AI practice guide…', message);
    });
    await state.coachHandoff.requestCoachResponse(credentials);
    if (flowEpoch !== state.flowEpoch) return;
    renderLearnerFeedbackLoading(
      document,
      'Finding a focused practice video…',
      'The coach note is ready. The backend is selecting a bounded YouTube recommendation.',
    );
    const feedback = await createFeedbackWithBoundedWait(sessionId);
    if (flowEpoch !== state.flowEpoch) return;
    renderLearnerFeedback(document, feedback);
    setLearnerStatus('Your AI practice guide is ready.');
    renderLearnerStage('review');
  } catch (error) {
    if (flowEpoch !== state.flowEpoch) return;
    const message = userMessage(error);
    renderLearnerFeedbackError(document, message);
    setLearnerStatus(message, true);
  } finally {
    await stopCoachFlow(sessionId);
  }
}

async function waitForProcessedResult(sessionId) {
  for (let attempt = 0; attempt < RESULT_POLL_ATTEMPTS; attempt += 1) {
    const result = await api.sessionResult(sessionId);
    if (['review_ready', 'failed', 'analysis_unavailable'].includes(result.status)) return result;
    renderLearnerFeedbackLoading(
      document,
      'Analyzing your reading…',
      `Backend analysis is still running. Status check ${attempt + 1} of ${RESULT_POLL_ATTEMPTS}.`,
    );
    await delay(RESULT_POLL_INTERVAL_MS);
  }
  throw new Error('Analysis is taking longer than expected. Use Check status to continue.');
}

async function createFeedbackWithBoundedWait(sessionId) {
  for (let attempt = 0; attempt < FEEDBACK_ATTEMPTS; attempt += 1) {
    try {
      return await api.createCoachFeedback(sessionId);
    } catch (error) {
      if (error?.code !== 'conflict' || attempt === FEEDBACK_ATTEMPTS - 1) throw error;
      await delay(FEEDBACK_RETRY_INTERVAL_MS);
    }
  }
  throw new Error('The coach response is not ready.');
}

async function stopCoachFlow(sessionId = state.coachingSessionId) {
  const handoff = state.coachHandoff;
  state.coachHandoff = null;
  await handoff?.close();
  if (!sessionId || !handoff) return;
  try {
    await api.stopCoachAgent(sessionId);
  } catch (error) {
    if (!['not_found', 'conflict'].includes(error?.code)) throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function renderBackendSession(session) {
  setLearnerStatus(renderSessionStatus(session.status));
  renderLearnerStage(session.status === 'review_ready' ? 'review' : 'process');
}

function renderLearnerStage(stage) {
  state.learnerStage = stage;
  const stages = ['consent', 'record', 'process', 'review'];
  const activeIndex = stages.indexOf(stage);
  for (const [index, name] of stages.entries()) {
    const item = document.querySelector(`#step-${name}`);
    item.classList.toggle('is-current', index === activeIndex);
    item.classList.toggle('is-complete', index < activeIndex);
  }
  const labels = { consent: 'Ready', record: 'Recording', process: 'Processing', review: 'Review ready' };
  document.querySelector('#session-state-badge').textContent = labels[stage];
}

function setLearnerStatus(message, error = false) {
  learnerStatus.textContent = message;
  learnerStatus.style.color = error ? 'var(--danger)' : '';
}

function guidedPassagePhrases() {
  return [...document.querySelectorAll('[data-passage-phrase]')]
    .map((phrase) => phrase.textContent.trim())
    .filter(Boolean);
}

function bindAnnotatorQueue() {
  document.querySelector('#refresh-queue').addEventListener('click', event => void refreshAnnotatorWorkspace(event.currentTarget));
}

async function refreshAnnotatorWorkspace(button) {
  const container = document.querySelector('#annotation-queue');
  const summary = document.querySelector('#queue-summary');
  if (button) button.disabled = true;
  summary.textContent = 'Loading review items…';
  try {
    const count = await renderAnnotationQueue(api, container, setAnnotationStatus);
    summary.textContent = count === 1 ? '1 sentence waiting for review' : `${count} sentences waiting for review`;
  } catch (error) {
    container.replaceChildren();
    summary.textContent = 'The review queue could not be loaded.';
    setAnnotationStatus(userMessage(error), true);
  } finally {
    if (button) button.disabled = false;
  }
}

function setAnnotationStatus(message, error = false) {
  const status = document.querySelector('#annotation-status');
  status.textContent = message;
  setPageStatus(message, error);
}

function setPageStatus(message, error = false) {
  const status = document.querySelector('#page-status');
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle('is-error', error);
}

function userMessage(error) {
  const messages = {
    unauthorized: 'The session or login details are invalid. Please try again.',
    forbidden: 'This account does not have permission for that action.',
    not_found: 'The requested item could not be found. Refresh the workspace.',
    conflict: 'Another session operation is in progress. Wait for it to finish.',
    model_unavailable: 'The private processing service is currently unavailable.',
  };
  if (error?.name === 'NotAllowedError') return 'Microphone access was denied. Enable it in your browser to record.';
  return messages[error?.code] ?? error?.message ?? 'An unexpected error occurred. Please try again.';
}
