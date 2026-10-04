import { CoachApi } from '../transport/coach-api.mjs';
import { LearnerSession, renderSessionStatus } from '../learner/session.mjs';
import { renderLearnerFeedback } from '../learner/feedback.mjs';
import { renderAnnotationQueue } from '../annotator/review.mjs';

const api = new CoachApi(globalThis.GABAYBIGKAS_API_BASE_URL ?? '');
const state = {
  account: null,
  coachingSessionId: null,
  learnerStage: 'consent',
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
    try {
      try {
        await learner.cancel();
      } catch {
        setLearnerStatus('The microphone stopped, but a pending audio upload was not completed.', true);
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
      renderBackendSession(await api.coachingSession(state.coachingSessionId));
    } catch (error) {
      setLearnerStatus(userMessage(error), true);
    } finally {
      refresh.disabled = false;
    }
  });
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
