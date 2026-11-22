// This document is loaded inside an opaque-origin, script-only sandbox.
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== new URL(location.href).origin || event.data?.type !== 'rea-preview' || typeof event.data.html !== 'string') return;
  document.open();
  document.write(event.data.html);
  document.close();
}, { once: true });
