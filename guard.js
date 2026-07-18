(function(){
  if(sessionStorage.getItem('sentrybatch-launch') === '1'){
    sessionStorage.removeItem('sentrybatch-launch');
    return;
  }
  document.documentElement.innerHTML = [
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1.0">',
    '<title>Sentry Batch</title>',
    '<style>',
    '*{margin:0;padding:0;box-sizing:border-box}',
    'body{display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,-apple-system,sans-serif;background:#0A0E13;color:#E7ECF2;text-align:center;padding:2rem}',
    'h1{font-size:1.75rem;margin-bottom:.75rem}',
    'p{color:#8FA0B3;line-height:1.6;margin-bottom:.35rem}',
    '.hint{color:#5A6B7D;font-size:.85rem;margin-top:1.25rem}',
    '</style>',
    '</head>',
    '<body>',
    '<div>',
    '<h1>\u{1F512} Sentry Batch</h1>',
    '<p>This page cannot be opened directly.</p>',
    '<p>Please launch Sentry Batch using<br><strong>"Open Sentry Batch"</strong>.</p>',
    '<p class="hint">This ensures the application starts correctly.</p>',
    '</div>',
    '</body>',
    '</html>'
  ].join('\n');
})();
