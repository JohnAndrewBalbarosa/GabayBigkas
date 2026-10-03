import { CoachApi } from '../transport/coach-api.mjs';
import { LearnerSession } from '../learner/session.mjs';
import { renderLearnerFeedback } from '../learner/feedback.mjs';
import { renderAnnotationQueue } from '../annotator/review.mjs';

const api = new CoachApi(globalThis.GABAYBIGKAS_API_BASE_URL ?? '');
const learnerStatus = document.querySelector('#learner-status');
const learner = new LearnerSession(api, status => { learnerStatus.textContent = status; });
const start = document.querySelector('#start-session');
const finish = document.querySelector('#finish-session');
let currentSession = null;

initializePage();

function initializePage() {
  renderLearnerFeedback(document, null);
  bindPublicNavigation();
  bindAuthentication();
  bindLearnerSession();
  bindAnnotatorImport();
  void restoreAccountSession();
}

function bindPublicNavigation() {
  document.querySelectorAll('[data-public-page]').forEach(button => {
    button.addEventListener('click', () => showPublicPage(button.dataset.publicPage));
  });
  document.querySelectorAll('[data-workspace]').forEach(button => {
    button.addEventListener('click', () => void showWorkspace(button.dataset.workspace));
  });
}

function bindAuthentication() {
  document.querySelector('#login form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = new FormData(event.currentTarget);
    const status = document.querySelector('#login-status');
    status.textContent = 'Nagla-log in…';
    try {
      activateAccount(await api.login(input.get('email'), input.get('password')));
      status.textContent = '';
    } catch (error) {
      status.textContent = error.message;
    }
  });
  document.querySelector('#logout').addEventListener('click', async () => {
    try {
      await api.logout();
      clearAccount('Naka-log out na ang account.');
    } catch (error) {
      setPageStatus(error.message);
    }
  });
}

async function restoreAccountSession() {
  try {
    activateAccount(await api.session());
  } catch {
    clearAccount('Mag-log in para buksan ang learner o annotator workspace.');
  }
}

function activateAccount(session) {
  currentSession = session;
  document.querySelector('#account').hidden = false;
  document.querySelector('#account-profile').textContent = `${session.email} · ${session.role}`;
  document.querySelector('#workspace-navigation').hidden = false;
  document.querySelectorAll('[data-workspace]').forEach(button => {
    button.hidden = button.dataset.workspace !== session.role;
  });
  setPageStatus('Na-restore ang secure account session.');
  void showWorkspace(session.role);
}

function clearAccount(message) {
  currentSession = null;
  document.querySelector('#account').hidden = true;
  document.querySelector('#workspace-navigation').hidden = true;
  hideWorkspaces();
  showPublicPage('home');
  setPageStatus(message);
}

function showPublicPage(page) {
  for (const id of ['home', 'about', 'login', 'signup']) {
    document.querySelector(`#${id}`).hidden = id !== page;
  }
  hideWorkspaces();
}

async function showWorkspace(role) {
  if (!currentSession || currentSession.role !== role) {
    setPageStatus('Hindi awtorisado ang account para sa workspace na iyon.');
    return;
  }
  for (const id of ['home', 'about', 'login', 'signup']) document.querySelector(`#${id}`).hidden = true;
  document.querySelector('#learner').hidden = role !== 'learner';
  document.querySelector('#annotator').hidden = role !== 'annotator';
  if (role === 'annotator') await refreshAnnotatorWorkspace();
}

function hideWorkspaces() {
  document.querySelector('#learner').hidden = true;
  document.querySelector('#annotator').hidden = true;
}

function bindLearnerSession() {
  start.addEventListener('click', async () => {
    try {
      await learner.start({
        exerciseId: 'mvp-guided-english',
        expectedPhrases: [document.querySelector('#reading-prompt').textContent.trim()],
        adultConsent: document.querySelector('#adult-consent').checked,
      });
      start.disabled = true;
      finish.disabled = false;
    } catch (error) {
      learnerStatus.textContent = error.message;
    }
  });
  finish.addEventListener('click', async () => {
    finish.disabled = true;
    try {
      const result = await learner.finish();
      renderLearnerFeedback(document, result.feedback ?? null);
    } catch (error) {
      learnerStatus.textContent = error.message;
    } finally {
      start.disabled = false;
    }
  });
}

async function refreshAnnotatorWorkspace() {
  try {
    await Promise.all([
      renderInferenceJobs(),
      renderAnnotationQueue(api, document.querySelector('#annotation-queue')),
    ]);
  } catch (error) {
    setPageStatus(error.message);
  }
}

async function renderInferenceJobs() {
  const container = document.querySelector('#inference-jobs');
  const jobs = await api.inferenceJobs();
  container.replaceChildren(...jobs.map(job => inferenceJobControls(job)));
  if (!jobs.length) container.textContent = 'Walang pending manual inference job.';
}

function inferenceJobControls(job) {
  const controls = document.createElement('div');
  const modalButton = document.createElement('button');
  modalButton.textContent = `Run on Modal · ${job.id}`;
  modalButton.addEventListener('click', () => void runInferenceOnModal(job.id, modalButton));
  const exportButton = document.createElement('button');
  exportButton.textContent = `Manual Colab fallback · ${job.id}`;
  exportButton.addEventListener('click', () => void downloadInferenceBundle(job.id));
  controls.append(modalButton, exportButton);
  return controls;
}

async function runInferenceOnModal(jobId, button) {
  const status = document.querySelector('#inference-status');
  button.disabled = true;
  status.textContent = `Pinoproseso sa private Modal T4 ang ${jobId}…`;
  try {
    const result = await api.runInferenceOnModal(jobId);
    status.textContent = `Modal complete: ${result.review_items} review item(s) ang handa.`;
    await refreshAnnotatorWorkspace();
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}

async function downloadInferenceBundle(jobId) {
  const blob = await api.downloadInferenceBundle(jobId);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `gabaybigkas-${jobId}.zip`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function bindAnnotatorImport() {
  document.querySelector('#import-inference-result').addEventListener('click', async () => {
    const status = document.querySelector('#inference-status');
    const file = document.querySelector('#inference-result').files[0];
    if (!file) {
      status.textContent = 'Pumili muna ng result JSON.';
      return;
    }
    try {
      const result = JSON.parse(await file.text());
      const imported = await api.importInferenceResult(result.job_id, result);
      status.textContent = imported.idempotent ? 'Na-import na dati ang parehong result.' : 'Na-import at handa na para sa review.';
      await refreshAnnotatorWorkspace();
    } catch (error) {
      status.textContent = error.message;
    }
  });
}

function setPageStatus(message) {
  document.querySelector('#page-status').textContent = message;
}
