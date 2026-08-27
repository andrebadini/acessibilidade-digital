export const REPORT_CSS = `
:root{color-scheme:light;font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#162330;background:#fff;--blue:#003b71;--blue-2:#005a9c;--pale:#eef5fb;--border:#9aa8b5;--failed:#8b1e1e;--review:#6b4e00;--passed:#175c34;--neutral:#34495e}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:#fff;color:#162330}
a{color:#004f8f;text-decoration-thickness:.12em;text-underline-offset:.15em}
a:focus-visible,summary:focus-visible{outline:3px solid #8b2f00;outline-offset:3px}
.skip-link{position:absolute;left:.75rem;top:-5rem;background:#fff;color:#003b71;border:3px solid #003b71;padding:.75rem;z-index:5}
.skip-link:focus{top:.75rem}
.report-header,.report-footer{background:#003b71;color:#fff;padding:1rem max(1rem,calc((100% - 72rem)/2))}
.report-header__inner{display:flex;align-items:baseline;gap:1rem;max-width:72rem;margin:auto;flex-wrap:wrap}
.product-name{font-size:1.6rem;font-weight:800;letter-spacing:.02em;margin:0}
.product-description{font-size:1rem;margin:0}
main{max-width:72rem;margin:auto;padding:1.5rem}
h1,h2,h3,h4{color:#003b71;line-height:1.2}
h1{font-size:clamp(2rem,4vw,3.2rem);margin:.25rem 0}
h2{font-size:1.75rem;border-bottom:3px solid #005a9c;padding-bottom:.35rem;margin-top:2.5rem}
h3{font-size:1.3rem}h4{font-size:1.1rem}
.lead{font-size:1.15rem;max-width:75ch}
.notice,.independence-notice{border-left:.4rem solid #6b4e00;background:#fff8df;padding:1rem}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.75rem;padding:0;list-style:none}
.summary-card,.item-card,.occurrence-card,.evidence-card,.review-card{border:1px solid #9aa8b5;border-radius:.35rem;padding:1rem;background:#fff}
.summary-card strong{display:block;font-size:1.8rem;color:#003b71}
.status{display:inline-flex;align-items:center;gap:.45rem;border:2px solid currentColor;border-radius:999px;padding:.15rem .55rem;font-weight:700;background:#fff}
.status--passed{color:#175c34}.status--failed{color:#8b1e1e}.status--cantTell{color:#6b4e00}.status--inapplicable,.status--untested{color:#34495e}
.meta{display:grid;grid-template-columns:minmax(10rem,15rem) 1fr;gap:.35rem 1rem}.meta dt{font-weight:700}.meta dd{margin:0;overflow-wrap:anywhere}
.item-list,.occurrence-list,.evidence-list,.review-list{display:grid;gap:1rem}
.item-card{break-inside:avoid}.item-card__heading{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;justify-content:space-between}
code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#f3f5f7;color:#17212b;border:1px solid #c7d0d8;border-radius:.25rem}
code{padding:.1rem .25rem}pre{padding:.75rem;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto}
details{margin-top:.75rem}summary{cursor:pointer;font-weight:700;color:#003b71;padding:.3rem}
.evidence-definitions{position:absolute;overflow:hidden;pointer-events:none}
.evidence-media{display:block;max-width:100%;height:auto;border:1px solid #687887;background:#eef1f4;margin-top:.75rem}
.evidence-annotation-note{border-left:.4rem solid #005a9c;background:#eef5fb;padding:1rem}
.occurrence-evidence{margin:1rem 0 0}.evidence-highlight-frame{position:relative;display:inline-block;max-width:100%;line-height:0;background:#eef1f4}.evidence-highlight-frame .evidence-media{margin:0}
.evidence-highlight{position:absolute;box-sizing:border-box;left:var(--highlight-left);top:var(--highlight-top);width:var(--highlight-width);height:var(--highlight-height);border:.5rem solid;pointer-events:none;print-color-adjust:exact;-webkit-print-color-adjust:exact}
.evidence-highlight--failed{border-color:#d00000;box-shadow:0 0 0 2px #fff,0 0 0 4px #650000}.evidence-highlight--review{border-color:#d97706;box-shadow:0 0 0 2px #fff,0 0 0 4px #5c2d00}.evidence-highlight--passed{border-color:#16803c;box-shadow:0 0 0 2px #fff,0 0 0 4px #0c4a24}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #788896;padding:.5rem;text-align:left;vertical-align:top}th{background:#e4eef7;color:#162330}
.report-footer{margin-top:3rem;font-size:.9rem}.report-footer p{max-width:72rem;margin:.25rem auto}
@page{size:A4;margin:18mm 15mm 20mm}
@media print{html{scroll-behavior:auto}.skip-link{display:none}.report-header,.report-footer{background:#fff;color:#162330;border-bottom:2px solid #003b71;padding:.5rem 0}.report-footer{border-top:2px solid #003b71;border-bottom:0}.major-section{break-before:page}.item-card,.occurrence-card,.evidence-card,.review-card,figure,details{break-inside:avoid}thead{display:table-header-group}a{color:#162330;text-decoration:none}main{max-width:none;padding:0}.status{color:#162330!important}}
@media (max-width:42rem){main{padding:1rem}.meta{grid-template-columns:1fr}.meta dd{margin-bottom:.5rem}.report-header__inner{align-items:flex-start;flex-direction:column}table{table-layout:fixed}th,td{overflow-wrap:anywhere}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;
