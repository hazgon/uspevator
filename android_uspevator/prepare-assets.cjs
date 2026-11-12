const fs = require('node:fs');
const path = require('node:path');
const ts = require('./tooling/typescript/lib/typescript.js');
const root = path.join(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'uspevator.html'), 'utf8');
const asset = html.replace(', viewport-fit=cover', '').replace('<meta charset="utf-8">', '<meta charset="utf-8">\n'
  + '  <link rel="icon" href="data:,">\n'
  + '  <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; img-src data:; object-src \'none\'; base-uri \'none\'; form-action \'none\'">')
  .replace(/<style>([\s\S]*?)<\/style>/, (_, css) => {
    const color = (match, hex) => {
      const bytes = hex.length === 4 ? Array.from(hex, char => parseInt(char + char, 16))
        : hex.match(/../g).map(part => parseInt(part, 16));
      return 'rgba(' + bytes.slice(0, 3).join(', ') + ', ' + bytes[3] / 255 + ')';
    };
    const compatible = css
      .replace(/#([\da-f]{8}|[\da-f]{4})\b/gi, color)
      .replace(/(^|[;{]\s*)gap:\s*([^;{}]+)/g, '$1grid-gap: $2; gap: $2')
      .replace('width: min(490px, 100% - 28px);', 'width: calc(100% - 28px); max-width: 490px;')
      .replace('width: min(680px, 100% - 28px);', 'max-width: 680px;')
      .replace('inset-inline-end: max(14px, env(safe-area-inset-right)); bottom: max(14px, env(safe-area-inset-bottom));', 'right: 14px; bottom: 14px;')
      .replace('max-width: min(400px, 100% - 28px);', 'max-width: 400px;')
      .replace(/overflow-wrap: anywhere/g, 'word-break: break-word; overflow-wrap: anywhere');
    const legacySpacing = '@supports not (gap: 1px) {'
      + '.brand strong{margin-left:10px}.btn .icon+span{margin-left:6px}.pill .dot{margin-right:5px}'
      + '.first-step-field summary span{margin-left:6px}.title-line .section-icon{margin-right:8px}}';
    return '<style>' + compatible + legacySpacing + '</style>';
  })
  .replace(/<script>([\s\S]*?)<\/script>/, (_, code) => {
    const result = ts.transpileModule(code.replace(/\bglobalThis\b/g, 'window'), {
      compilerOptions: {target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.None},
      reportDiagnostics: true
    });
    const errors = result.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
    return '<script>\n' + result.outputText + '</script>';
  });
fs.writeFileSync(path.join(__dirname, 'app/assets/index.html'), asset);
