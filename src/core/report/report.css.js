export const REPORT_CSS = `
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55;color:#14212b;background:#fff;--ink:#14212b;--surface:#fff;--navy:#003b71;--blue:#005a9c;--focus:#8b2f00;--muted:#738596;--pale:#eef4f8;--danger:#8b1e1e;--review:#6b4e00}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:#fff;color:#14212b}
a{color:#005a9c;text-decoration-thickness:.12em;text-underline-offset:.15em}
a:focus-visible,button:focus-visible,select:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid #8b2f00;outline-offset:3px;box-shadow:0 0 0 6px #fff}
.skip-link{position:absolute;left:.75rem;top:-6rem;min-height:44px;background:#fff;color:#003b71;border:3px solid #003b71;padding:.65rem .9rem;z-index:10}
.skip-link:focus{top:.75rem}
.report-header,.report-footer{background:#003b71;color:#fff;padding:1rem max(1rem,calc((100% - 72rem)/2))}
.report-header__inner{display:flex;align-items:baseline;gap:1rem;max-width:72rem;margin:auto;flex-wrap:wrap}
.product-name{font-size:1.5rem;font-weight:800;letter-spacing:.01em;margin:0}
.product-description{font-size:1rem;margin:0}
main{max-width:72rem;margin:auto;padding:1.5rem}
h1,h2,h3,h4{color:#003b71;line-height:1.2;overflow-wrap:anywhere}
h1{font-size:clamp(2rem,4vw,3rem);margin:.25rem 0}
h2{font-size:1.7rem;border-bottom:3px solid #005a9c;padding-bottom:.4rem;margin:2.5rem 0 1rem}
h3{font-size:1.25rem;margin:0 0 .75rem}
h4{font-size:1.05rem;margin:1.25rem 0 .5rem}
p,li,dd,dt,th,td,code{overflow-wrap:anywhere}
.lead{font-size:1.12rem;max-width:75ch}
.notice,.independence-notice,.coverage-notice,.evidence-scope-banner{border-left:.4rem solid #6b4e00;background:#eef4f8;padding:1rem;margin:1rem 0}
.section-intro{max-width:78ch}
.section-nav{border:1px solid #738596;border-radius:.3rem;background:#eef4f8;padding:.75rem 1rem;margin:1.5rem 0}
.section-nav ul{display:flex;flex-wrap:wrap;gap:.5rem 1rem;margin:.35rem 0;padding-left:0;list-style:none}
.scope-grid,.summary-grid,.page-grid,.widget-grid{display:grid;gap:.75rem;margin:1rem 0}
.scope-card,.summary-card,.page-card,.occurrence-card,.review-card,.widget-card,.evidence-card,.map-card,.method-card{border:1px solid #738596;border-radius:.3rem;padding:1rem;background:#fff}
.scope-card,.page-card{background:#eef4f8}
.summary-card strong{display:block;font-size:1.8rem;color:#003b71}
.summary-card span{display:block}
.summary-card--failed{border-left:.5rem double #8b1e1e}
.summary-card--review{border-left:.5rem dashed #6b4e00}
.summary-card--neutral{border-left:.5rem solid #738596}
.meta{display:grid;grid-template-columns:minmax(8rem,12rem) minmax(0,1fr);gap:.35rem 1rem;margin:.5rem 0}
.meta dt{font-weight:750}
.meta dd{margin:0}
.status,.chip{display:inline-flex;align-items:center;gap:.4rem;min-height:2rem;border:2px solid currentColor;border-radius:.3rem;padding:.15rem .55rem;font-weight:750;background:#fff}
.status--failed{color:#8b1e1e}.status--cantTell{color:#6b4e00}.status--passed{color:#003b71}.status--inapplicable,.status--untested{color:#14212b}
.chip--requirement{color:#fff;background:#003b71;border-color:#003b71}.chip--recommendation{color:#005a9c}.chip--best-practice{color:#14212b;border-color:#738596}.chip--editorial{color:#6b4e00;border-style:dashed}
.chip-row{display:flex;flex-wrap:wrap;gap:.5rem;margin:.5rem 0 1rem}
.page-status{font-weight:750}
.filters-shell{border:1px solid #738596;border-radius:.3rem;background:#eef4f8;padding:1rem}
.filters-grid{display:grid;grid-template-columns:1fr;gap:.75rem}
.filter-field{display:grid;gap:.3rem}
.filter-field label{font-weight:750}
select,button{font:inherit;min-height:44px;border:2px solid #738596;border-radius:.3rem;background:#fff;color:#14212b;padding:.55rem .7rem}
button{cursor:pointer;font-weight:750;color:#003b71;border-color:#003b71}
button:hover{background:#eef4f8}
button:disabled,select:disabled{cursor:not-allowed;opacity:1;color:#738596;border-color:#738596;background:#fff}
.filter-actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1rem}
.filter-status{font-weight:750;margin:.85rem 0 0}
.filters-noscript{margin:.5rem 0;color:#6b4e00}
.report-enhanced .filters-noscript{display:none}
.empty-state{border:3px dashed #6b4e00;border-radius:.3rem;padding:1.5rem;margin:1rem 0;background:#eef4f8}
.occurrence-list,.review-list,.evidence-list,.map-list,.method-grid{display:grid;gap:1rem}
.occurrence-card{border-width:2px;break-inside:avoid}
.occurrence-card[data-display-outcome="failed"]{border-left:.55rem double #8b1e1e}
.occurrence-card[data-display-outcome="cantTell"]{border-left:.55rem dashed #6b4e00}
.occurrence-heading{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.75rem;align-items:flex-start}
.occurrence-heading h3{flex:1 1 28rem}
.decision-strip{display:grid;gap:.35rem;border-left:.3rem solid #738596;background:#eef4f8;padding:.75rem;margin:1rem 0}
.decision-strip p{margin:0}
.observed,.confirm{border-top:1px solid #738596;padding-top:.75rem;margin-top:.75rem}
.normative-map{background:#eef4f8;border-radius:.3rem;padding:.75rem;margin:1rem 0}
.normative-map p{margin:.3rem 0}
.legal-analysis{border:3px double #8b2f00;border-radius:.3rem;padding:1rem;margin-top:1rem;background:#fff}
.legal-analysis h4{color:#8b2f00;margin-top:0}
details{margin-top:1rem;border-top:1px solid #738596;padding-top:.5rem}
summary{cursor:pointer;font-weight:750;color:#003b71;min-height:44px;padding:.55rem .25rem}
code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#eef4f8;color:#14212b;border:1px solid #738596;border-radius:.3rem}
code{padding:.1rem .25rem}
pre{padding:.75rem;white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden}
.evidence-definitions{position:absolute;width:0;height:0;overflow:hidden;pointer-events:none}
.evidence-media{display:block;max-width:100%;height:auto;border:1px solid #738596;background:#eef4f8;margin-top:.75rem}
.evidence-highlight{fill:none;vector-effect:non-scaling-stroke;pointer-events:none;stroke-width:7}
.evidence-highlight--failed{stroke:#8b1e1e}.evidence-highlight--review{stroke:#6b4e00;stroke-dasharray:14 9}.evidence-highlight--passed{stroke:#003b71;stroke-dasharray:4 4}
.occurrence-evidence{margin:1rem 0 0}
.page-level-evidence{border:4px double #738596;border-radius:.3rem;padding:.5rem;background:#eef4f8}
.page-level-evidence--failed{border-color:#8b1e1e}.page-level-evidence--review{border-style:dashed;border-color:#6b4e00}.page-level-evidence--passed{border-color:#003b71}
.evidence-scope-banner{border-left-color:#005a9c}
.map-unavailable{border:2px dashed #738596;border-radius:.3rem;padding:1rem;background:#eef4f8}
.map-card,.announcement-map-segment,.announcement-map-legend{min-width:0}
.map-card[data-map-status="complete"]{border-left:.4rem solid #003b71}.map-card[data-map-status="partial"]{border-left:.4rem dashed #6b4e00}.map-card[data-map-status="empty"],.map-card[data-map-status="absent"]{border-left:.4rem double #738596}
.map-state{border-left:.3rem solid #003b71;background:#eef4f8;padding:.75rem}.map-state--partial{border-left-color:#6b4e00}.map-state--empty{border-left-color:#738596}
.map-meta{border-top:1px solid #738596;border-bottom:1px solid #738596;padding:.75rem 0}
.announcement-map-segments{display:grid;gap:1rem;margin-top:1rem}
.announcement-map-segment{margin:0;border:1px solid #738596;border-radius:.3rem;padding:.75rem;background:#eef4f8;break-inside:avoid}
.announcement-map-segment figcaption{margin-top:.6rem;font-size:.92rem}
.map-meta code,.announcement-map-segment figcaption code,.legend-selector code{word-break:break-all}
.announcement-map-legend{display:grid;gap:.65rem;padding-left:2rem}
.announcement-map-legend li{padding:.65rem;border-bottom:1px solid #738596;break-inside:avoid}
.announcement-map-legend li span{display:block}.legend-selector{font-weight:750;margin-bottom:.25rem}
.review-card[data-review-state="answered"]{border-left:.4rem solid #003b71}.review-card[data-review-state="unanswered"]{border-left:.4rem dashed #6b4e00}
.widget-state{font-weight:750}.widget-card[data-widget-state="present"]{border-left:.4rem solid #003b71}.widget-card[data-widget-state="absent"]{border-left:.4rem double #738596}.widget-card[data-widget-state="unknown"]{border-left:.4rem dashed #6b4e00}
.matrix-scroll{overflow-x:auto;border:1px solid #738596;border-radius:.3rem}
.matrix-scroll table{min-width:58rem}
table{width:100%;border-collapse:collapse}
th,td{border:1px solid #738596;padding:.55rem;text-align:left;vertical-align:top}
th{background:#eef4f8;color:#14212b}
.evidence-group{border-top:3px solid #005a9c;padding-top:.75rem}
.evidence-relation{font-size:.92rem;color:#14212b}
.method-grid{grid-template-columns:1fr}
.compact-list{margin:.5rem 0;padding-left:1.3rem}
.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.report-footer{margin-top:3rem;font-size:.9rem}
.report-footer p{max-width:72rem;margin:.25rem auto}
@media (min-width:42rem){.filters-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.scope-grid,.page-grid,.widget-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.summary-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (min-width:64rem){.filters-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.scope-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.summary-grid{grid-template-columns:repeat(5,minmax(0,1fr))}.page-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.method-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@page{size:A4 portrait;margin:18mm 15mm 20mm}
@media print{html{scroll-behavior:auto}.skip-link,.section-nav,.filters-shell,.filter-actions,.empty-state{display:none!important}.report-header,.report-footer{background:#fff;color:#14212b;border-bottom:2px solid #003b71;padding:.5rem 0}.report-footer{border-top:2px solid #003b71;border-bottom:0}.major-section{break-before:page}.scope-card,.summary-card,.page-card,.occurrence-card,.review-card,.widget-card,.evidence-card,.method-card,.announcement-map-segment,.announcement-map-legend li,details{break-inside:avoid}.occurrence-card[hidden]{display:block!important}details:not([open])>*:not(summary){display:block!important}thead{display:table-header-group}a{color:#14212b;text-decoration:none}main{max-width:none;padding:0}.status,.chip{color:#14212b!important;background:#fff!important;border-color:#14212b!important}.matrix-scroll{overflow:visible}.matrix-scroll table{min-width:0;font-size:8.5pt}.report-enhanced .filters-noscript{display:block}.filters-noscript::after{content:" Todos os registros foram incluídos na impressão."}}
@media (max-width:42rem){main{padding:1rem}.meta{grid-template-columns:1fr}.meta dd{margin-bottom:.5rem}.report-header__inner{align-items:flex-start;flex-direction:column}.filter-actions{display:grid}.filter-actions button{width:100%}.occurrence-heading{display:block}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media (forced-colors:active){*{forced-color-adjust:auto}.status,.chip,.scope-card,.summary-card,.page-card,.occurrence-card,.review-card,.widget-card,.evidence-card,.map-card,.method-card,.filters-shell,.legal-analysis,.page-level-evidence{border-color:CanvasText}.occurrence-card[data-display-outcome="failed"]{border-left-style:double}.occurrence-card[data-display-outcome="cantTell"]{border-left-style:dashed}.evidence-highlight{stroke:CanvasText}.evidence-highlight--review{stroke-dasharray:14 9}a:focus-visible,button:focus-visible,select:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline-color:Highlight;box-shadow:none}}
`;

// Updated by the CSP integrity test whenever the static stylesheet changes.
export const REPORT_CSS_CSP_HASH = 'sha256-VrYeXfgzigfqTduxBXCLFryR9dhRZoIZZPTvRON4WC0=';
