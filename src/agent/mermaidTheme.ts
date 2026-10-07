// One house style for every Mermaid diagram Freebird shows — the chat view and
// the create_diagram preview page both inline this script and call
// freebirdMermaidInit() before rendering. No vscode import, so it is testable.
//
// Why a custom 'base' theme instead of Mermaid's built-ins: the stock 'dark'
// theme renders drab grey nodes with grey chips behind edge labels and a grey
// slab for subgraphs; 'neo-dark' adds saturated red/blue gradient borders and
// the 'redux' themes are stark black-and-white. Rendered side by side (see the
// project history for the comparison), a base theme with a curated blue-grey
// palette was the only one that stayed readable at a glance. ELK layout was
// also tried but the bundled build doesn't register it, so it falls back to
// dagre — not worth the dependency.
//
// mode: 'dark' | 'light' forces a palette; omitted, it follows VS Code's body
// class (the chat view needs this — light themes used to get a dark diagram).

export const MERMAID_THEME_SCRIPT = `
function freebirdMermaidInit(mode) {
  var cls = document.body ? document.body.classList : null;
  var light = mode ? mode === 'light'
    : !!(cls && (cls.contains('vscode-light') || cls.contains('vscode-high-contrast-light')));
  var dark = {
    darkMode: true, background: 'transparent',
    primaryColor: '#313244', primaryTextColor: '#cdd6f4', primaryBorderColor: '#89b4fa',
    secondaryColor: '#3b3f58', secondaryTextColor: '#cdd6f4', secondaryBorderColor: '#a6adc8',
    tertiaryColor: '#1e1e2e', tertiaryTextColor: '#cdd6f4', tertiaryBorderColor: '#45475a',
    lineColor: '#9399b2', textColor: '#cdd6f4',
    mainBkg: '#313244', nodeBorder: '#89b4fa', nodeTextColor: '#cdd6f4',
    clusterBkg: 'rgba(137,180,250,0.07)', clusterBorder: '#585b70',
    edgeLabelBackground: '#1e1e2e', titleColor: '#cdd6f4',
    noteBkgColor: '#45475a', noteTextColor: '#cdd6f4', noteBorderColor: '#585b70',
    actorBkg: '#313244', actorBorder: '#89b4fa', actorTextColor: '#cdd6f4', actorLineColor: '#585b70',
    signalColor: '#9399b2', signalTextColor: '#cdd6f4',
    labelBoxBkgColor: '#313244', labelBoxBorderColor: '#585b70', labelTextColor: '#cdd6f4',
    loopTextColor: '#cdd6f4', activationBkgColor: '#45475a', activationBorderColor: '#89b4fa',
    sequenceNumberColor: '#1e1e2e'
  };
  var lite = {
    darkMode: false, background: 'transparent',
    primaryColor: '#e6edff', primaryTextColor: '#1f2335', primaryBorderColor: '#4a6fd8',
    secondaryColor: '#eef1f8', secondaryTextColor: '#1f2335', secondaryBorderColor: '#8b93ad',
    tertiaryColor: '#f7f8fc', tertiaryTextColor: '#1f2335', tertiaryBorderColor: '#c9cee0',
    lineColor: '#6b7390', textColor: '#1f2335',
    mainBkg: '#e6edff', nodeBorder: '#4a6fd8', nodeTextColor: '#1f2335',
    clusterBkg: 'rgba(74,111,216,0.06)', clusterBorder: '#b5bdd6',
    edgeLabelBackground: '#ffffff', titleColor: '#1f2335',
    noteBkgColor: '#fff6d6', noteTextColor: '#1f2335', noteBorderColor: '#e0cf8a',
    actorBkg: '#e6edff', actorBorder: '#4a6fd8', actorTextColor: '#1f2335', actorLineColor: '#b5bdd6',
    signalColor: '#6b7390', signalTextColor: '#1f2335',
    labelBoxBkgColor: '#e6edff', labelBoxBorderColor: '#b5bdd6', labelTextColor: '#1f2335',
    loopTextColor: '#1f2335', activationBkgColor: '#dbe3f7', activationBorderColor: '#4a6fd8',
    sequenceNumberColor: '#ffffff'
  };
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: Object.assign({ fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif', fontSize: '15px' }, light ? lite : dark),
    flowchart: { curve: 'basis', htmlLabels: true, padding: 14, nodeSpacing: 46, rankSpacing: 62, wrappingWidth: 220, diagramPadding: 16 },
    sequence: { actorMargin: 64, messageMargin: 42, boxMargin: 12, mirrorActors: false, wrap: true, width: 170 },
    er: { entityPadding: 18, fontSize: 14 },
    class: { padding: 12 },
    state: { padding: 12 }
  });
}
`;
