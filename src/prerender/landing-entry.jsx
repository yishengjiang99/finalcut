// Build-time entry for scripts/prerender-landing.mjs: renders the landing page to static HTML
// that is placed inside <div id="root"> of dist/index.html. React replaces it on load.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Landing from '../Landing.jsx';

const noop = () => {};

export function renderLanding() {
  return renderToStaticMarkup(<Landing onGetStarted={noop} onLoadSample={noop} authError={null} />);
}
