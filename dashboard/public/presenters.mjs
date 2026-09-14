function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]);
}

function definition(label, value, className = '') {
  return `<dt>${escapeHtml(label)}</dt><dd${className ? ` class="${className}"` : ''}>${escapeHtml(value)}</dd>`;
}

export function executionDisclosure(view) {
  const statusClass = String(view.status ?? '').replace(/[^a-z-]/gi, '');
  return `<details class="mobile-record execution-record">
    <summary>
      <span class="record-line"><span class="status ${statusClass}">${escapeHtml(view.statusLabel)}</span><time>${escapeHtml(view.started)}</time></span>
      ${view.node ? `<span class="record-node">${escapeHtml(view.node)}</span>` : ''}
    </summary>
    <dl class="record-details">
      ${definition('Duration', view.duration)}
      ${definition('Mode', view.mode)}
      ${definition('Execution', `#${view.id}`, 'mono')}
      ${view.error ? definition('Error', view.error, 'record-error') : ''}
    </dl>
  </details>`;
}

export function videoDisclosure(view) {
  return `<details class="mobile-record video-record">
    <summary>
      <span class="record-file">${escapeHtml(view.file)}</span>
      <span class="record-duration">${escapeHtml(view.duration)}</span>
    </summary>
    <div class="video-details">
      <div>${escapeHtml(view.created)} · ${escapeHtml(view.size)}</div>
      <video controls preload="none" src="${escapeHtml(view.url)}"></video>
    </div>
  </details>`;
}
