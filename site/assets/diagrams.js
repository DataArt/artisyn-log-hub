// Renders ```text diagram=<name> blocks of the docs pages (site/diagrams/<name>.mmd) with Mermaid,
// themed from the site's CSS tokens. The ASCII original stays in a <details> "Text version" that
// is open until the diagram has rendered, so the page reads fine without JS or the CDN.
(function () {
  var nodes = document.querySelectorAll('pre.mermaid');
  if (nodes.length === 0 || !window.mermaid) return;
  var css = getComputedStyle(document.documentElement);
  function v(name) { return css.getPropertyValue(name).trim(); }
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: v('--mono'),
    themeVariables: {
      fontFamily: v('--mono'),
      fontSize: '14px',
      background: v('--surface'),
      primaryColor: v('--page'),
      primaryTextColor: v('--text'),
      primaryBorderColor: v('--accent'),
      secondaryColor: v('--stage'),
      tertiaryColor: v('--surface'),
      lineColor: v('--text-2'),
      textColor: v('--text'),
      clusterBkg: v('--surface'),
      clusterBorder: v('--border'),
      edgeLabelBackground: v('--surface'),
    },
    flowchart: { curve: 'linear', htmlLabels: true, wrappingWidth: 260 },
  });
  window.mermaid.run({ nodes: nodes }).then(function () {
    nodes.forEach(function (n) {
      var fig = n.closest('.diagram');
      var details = fig && fig.querySelector('details');
      if (details) details.open = false;
      if (fig) fig.classList.add('diagram-ready');
    });
  }).catch(function () { /* keep the open text version */ });
})();
