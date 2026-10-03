import { CoachApi } from '../transport/coach-api.mjs';
import { LearnerSession } from '../learner/session.mjs';
import { renderAnnotationQueue } from '../annotator/review.mjs';

const api = new CoachApi(globalThis.GABAYBIGKAS_API_BASE_URL ?? '');
const learnerStatus = document.querySelector('#learner-status');
const learner = new LearnerSession(api, status => { learnerStatus.textContent = status; });
const start = document.querySelector('#start-session');
const finish = document.querySelector('#finish-session');

document.querySelector('#login form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = new FormData(event.currentTarget);
  try {
    const session = await api.login(input.get('email'), input.get('password'));
    showView(session.role);
  } catch (error) {
    alert(error.message);
  }
});

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));

start.addEventListener('click', async () => {
  try {
    await learner.start({
      exerciseId: 'mvp-guided-english',
      expectedPhrases: ['Fifty people think clearly.'],
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
    await learner.finish();
  } catch (error) {
    learnerStatus.textContent = error.message;
  } finally {
    start.disabled = false;
  }
});

async function showView(role) {
  document.querySelector('#login').hidden = true;
  document.querySelector('#learner').hidden = role !== 'learner';
  document.querySelector('#annotator').hidden = role !== 'annotator';
  if (role === 'annotator') {
    await renderInferenceJobs();
    await renderAnnotationQueue(api, document.querySelector('#annotation-queue'));
  }
}

async function renderInferenceJobs() {
  const container = document.querySelector('#inference-jobs');
  const jobs = await api.inferenceJobs();
  container.replaceChildren(...jobs.map(job => {
    const button = document.createElement('button');
    button.textContent = `I-export ${job.id}`;
    button.addEventListener('click', async () => {
      const blob = await api.downloadInferenceBundle(job.id);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `gabaybigkas-${job.id}.zip`;
      link.click();
      URL.revokeObjectURL(link.href);
    });
    return button;
  }));
  if (!jobs.length) container.textContent = 'Walang pending manual inference job.';
}

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
    await renderInferenceJobs();
    await renderAnnotationQueue(api, document.querySelector('#annotation-queue'));
  } catch (error) {
    status.textContent = error.message;
  }
});
