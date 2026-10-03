export async function renderAnnotationQueue(api, container) {
  const items = await api.annotationQueue();
  container.replaceChildren(...items.map(item => annotationCard(api, item)));
  if (!items.length) container.textContent = 'No pending review items.';
}

function annotationCard(api, item) {
  const card = document.createElement('article');
  card.className = 'review-card';
  card.append(
    evidenceLine('Target sentence', item.expected_text),
    evidenceLine('Agora', item.agora_text),
    evidenceLine('BuzzASR', item.buzz_text),
  );
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'none';
  audio.src = `/api/annotation/items/${encodeURIComponent(item.id)}/audio`;
  const actions = document.createElement('div');
  actions.className = 'actions';
  card.append(audio, actions);
  for (const decision of ['confirmed_transcript', 'insufficient_evidence', 'out_of_scope_language']) {
    const button = document.createElement('button');
    button.textContent = decision.replaceAll('_', ' ');
    button.addEventListener('click', async () => {
      await api.decideAnnotation(item.id, { decision });
      card.remove();
    });
    actions.append(button);
  }
  return card;
}

function evidenceLine(label, value) {
  const line = document.createElement('p');
  const heading = document.createElement('strong');
  heading.textContent = `${label}: `;
  line.append(heading, document.createTextNode(value));
  return line;
}
