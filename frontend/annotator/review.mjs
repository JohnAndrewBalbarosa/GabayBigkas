export async function renderAnnotationQueue(api, container) {
  const items = await api.annotationQueue();
  container.replaceChildren(...items.map(item => annotationCard(api, item)));
  if (!items.length) container.textContent = 'Walang pending review item.';
}

function annotationCard(api, item) {
  const card = document.createElement('article');
  card.className = 'review-card';
  card.innerHTML = `
    <p><strong>Target sentence:</strong> ${escapeHtml(item.expected_text)}</p>
    <p><strong>Agora:</strong> ${escapeHtml(item.agora_text)}</p>
    <p><strong>BuzzASR:</strong> ${escapeHtml(item.buzz_text)}</p>
    <audio controls preload="none" src="/api/annotation/items/${encodeURIComponent(item.id)}/audio"></audio>
    <div class="actions"></div>`;
  const actions = card.querySelector('.actions');
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

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}
